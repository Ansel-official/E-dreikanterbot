# 记忆库设计

E-dreikanterbot 的「记忆」分三层，全部本地持久化，不依赖外部向量库。

```text
data/
├─ conversations/
│  └─ c_xxx.json          # 一条会话：消息、思考、工具、用量
├─ memory.json            # 长期记忆：事实、标签、置顶
├─ files/                 # 用户上传的图片
└─ secret.txt             # 会话 Cookie 签名密钥（自动生成）
```

---

## 1. 会话存档

每条消息是：

```json
{
  "id": "m_xxx",
  "role": "assistant",
  "content": "最终回答",
  "reasoning": "思考链",
  "thinking": true,
  "toolCalls": [{ "id": "call_x", "type": "function", "function": { "name": "remember_fact", "arguments": "{\"text\":\"...\"}" } }],
  "toolCallId": "call_x",
  "hidden": true,
  "usage": { "prompt_tokens": 120, "completion_tokens": 30, "cached_tokens": 64, "cost": 0.0001 },
  "createdAt": "2026-11-26T10:00:00.000Z"
}
```

- `hidden`：工具循环产生的中间消息，网页不显示，但下一轮必须回传给 API。
- `aborted`：用户中途停止，保留已生成的部分。
- 写入采用「临时文件 + rename」原子替换，单会话串行写，避免并发覆盖。

### 重新生成

删除末尾所有非 user 消息（含隐藏的工具消息），保留最后一条用户消息后重跑。这样不会重复写入用户消息，也不会让 `tool_calls` 与 `tool` 消息失衡。

### 上下文裁剪

- 先用轻量估算：中文约 0.62 token/字，其他约 0.28 token/字符。
- 预留 `max_tokens` 作为输出空间，输入预算 = min(`MAX_CONTEXT_TOKENS`, 1,000,000 − 输出 − 2048)。
- 从最旧消息开始丢弃，但始终保留最后一条用户消息。
- 发生裁剪时，在 system 末尾追加一行提示，告知模型「较早的 N 条消息已省略」。

真实 token 以官方 `usage` 为准，估算只用于控制成本与避免 400。

---

## 2. 长期记忆

`data/memory.json`：

```json
{
  "version": 1,
  "facts": [
    {
      "id": "mem_xxx",
      "seq": 1,
      "text": "用户偏好中文回答，代码示例使用 TypeScript",
      "tags": ["偏好"],
      "source": "model",
      "pinned": false,
      "createdAt": "2026-11-26T10:00:00.000Z",
      "updatedAt": "2026-11-26T10:00:00.000Z",
      "useCount": 3,
      "lastUsedAt": "2026-11-26T12:00:00.000Z"
    }
  ]
}
```

- 写入时按 `normalizeText` 去重（忽略空白与标点）。
- 单条上限 2000 字；最多 5000 条，超出时淘汰最早的非置顶条目。
- 支持手动添加、置顶、复制、删除，也可由模型调用工具写入。

---

## 3. 检索：BM25-lite

不引入向量模型，使用中文友好的轻量 BM25：

1. **分词**：英文按 `[a-z0-9_]{2,}`；中文逐字 + 双字（bigram）。例如「深色模式」→ 深、深色、色、色模、模、模式……
2. **打分**：

```text
idf(t) = ln(1 + (N + 1) / (df(t) + 0.5))
score  = Σ idf(t) · tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl))
```

`k1=1.4`、`b=0.75`；标签命中 +0.8，置顶 +0.4。

3. **注入**：取 Top-K（默认 8），如果不足则补置顶记忆；受 `MEMORY_MAX_CHARS` 限制。

适合个人/小团队的偏好、项目背景、稳定事实；不适合百万级知识库。需要语义检索时可在 `MemoryStore.search` 处替换实现。

---

## 4. 注入顺序与缓存友好性

每轮 system 内容固定为：

```text
[人设]
<memory>
- [2026-11-20] 事实 A（标签：偏好）
- [2026-11-22] 事实 B
</memory>
当前日期：2026-11-26（星期四，时区 Asia/Shanghai）。用户主要使用简体中文。
```

关键点：

- **记忆块内部按 `createdAt` + `seq` 升序**，新增事实只追加在尾部。
- 不用「相关度排序」拼接，否则每次检索顺序变化会让前缀缓存全部失效。
- 日期只精确到天，避免每轮都改变 system。
- 记忆变化时，旧前缀仍能命中缓存，只有新增部分需要重新计算。

DeepSeek 缓存按前缀单元匹配，因此这种稳定顺序能显著提升 `prompt_cache_hit_tokens`。前端会显示每轮的缓存命中率。

---

## 5. 模型工具

启用记忆时，请求会携带两个 function tools：

### `remember_fact`

```json
{
  "text": "一条自包含的第三人称事实",
  "tags": ["偏好"]
}
```

- 由模型判断是否具有长期价值。
- 服务端二次校验：非空、≤ 2000 字、去重。
- 成功后返回 `{ok, id, duplicate, saved}`，UI 显示「已记住：…」。
- system 人设里明确要求：寒暄、一次性任务、对话中可见的内容不要写入。

### `recall_memory`

```json
{ "query": "关键词或短句" }
```

返回最多 6 条 `{id, text, tags, createdAt, score}`。

> **官方约束**：DeepSeek 请求携带 `tools` 时，所有历史助手消息的 `reasoning_content` 必须完整回传。本项目在思考模式下会持久化并回传；若历史中确实缺少（例如导入的旧会话），本轮会自动关闭记忆工具，只做静态记忆注入，避免 400。
>
> **Kimi K3 系列**：始终开启 Preserved Thinking，无论是否带 tools，多轮请求都应回传历史 assistant 的 `reasoning_content`。本项目对 Kimi 会话默认全量回传；切换模型到 Kimi 时也会尽量保留历史思考内容。

---

## 6. 隐私与备份

- 记忆与会话只存本机 `data/`，不经过第三方。
- `.gitignore` 已忽略 `data/`、`data-demo/`、`.env`。
- 备份：

```bash
tar -czf edb-backup-$(date +%F).tgz data/
```

- 迁移：把整个 `data/` 目录复制到新机器，保持目录结构即可。
- 清除记忆：删除 `data/memory.json` 或调用 `DELETE /api/memory/:id`。
- 删除会话会同时删除该会话上传的图片。

---

## 7. 调优

| 目标 | 调整 |
| --- | --- |
| 记忆更克制 | `MEMORY_TOP_K=4`、`MEMORY_MAX_CHARS=2000` |
| 长对话更省 token | 降低 `MAX_CONTEXT_TOKENS` |
| 关闭记忆工具 | 参数面板关闭「长期记忆」，或 `MEMORY_ENABLED=false` |
| 需要更强检索 | 替换 `MemoryStore.search` 为向量检索，保持返回结构 |
