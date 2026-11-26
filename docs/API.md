# API 文档

本文对应 **DeepSeek Chat Completions API** 与 **Kimi（Moonshot）Chat Completions API**。两家都是 OpenAI 兼容协议，但参数约束不同，本项目在 Provider 层做了适配。

- DeepSeek 官方文档：<https://api-docs.deepseek.com/api/create-chat-completion>
- Kimi 官方文档：<https://platform.kimi.com/docs/api/chat>

E-dreikanterbot 提供两套接口：

1. **原生接口** `/api/*`：给网页使用，事件流更细（思考、工具、用量、标题分开推送），会自动注入记忆与工具。
2. **OpenAI 兼容接口** `/v1/*`：给 SDK / 第三方客户端使用，请求与响应格式与官方一致，**不做**记忆注入，纯粹按模型路由。

---

## 0. 上游与模型

| 项 | DeepSeek | Kimi（Moonshot） |
| --- | --- | --- |
| Base URL | `https://api.deepseek.com` | `https://api.moonshot.cn/v1`（海外 `https://api.moonshot.ai/v1`） |
| Chat Completions | `POST /chat/completions` | `POST /chat/completions` |
| 当前模型 | `deepseek-flash`（视觉）、`deepseek-v4-pro` | `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.6`（K2.7 已对新人停开） |
| 上下文 | 1,048,576 | K3：1,048,576；K2：262,144 |
| 最大输出 | 393,216 | K3：1,048,576（`max_completion_tokens`）；K2：262,144 |
| 思考 | `thinking` + `reasoning_effort` | K3 始终思考，仅 `reasoning_effort`；K2.6 可开关 |
| 模型列表 | `GET /models` | `GET /models` |

> 模型与能力以服务端启动时拉取的官方 `/models` 为准；Kimi 的上下文档位来自官方文档内置元数据。

官方计价（美元 / 1M tokens，2026-11 文档）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- |
| deepseek-flash | $0.003 / $0.006（谷/峰） | $0.15 / $0.30 | $0.6 / $1.2 |
| deepseek-v4-pro | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

高峰：UTC 周一至周五 01:00–04:00、06:00–10:00；其余为低峰（节假日未在本地判定）。

---

## 1.5 Provider 适配规则

### DeepSeek

- `thinking: {type: enabled|disabled}`
- `reasoning_effort: low|high|max`
- `max_tokens`（1–393216）
- `temperature` / `top_p` 仅非思考模式生效
- `safety_check` / `title` / `user_id`
- `deepseek_web_search` / `deepseek_read_url`

### Kimi

- **K3 系列（kimi-k3.1-pro / highspeed / kimi-k3）**
  - 始终开启思考与 Preserved Thinking
  - 只接受顶层 `reasoning_effort: low|high|max`（默认 `max`）
  - **不要传** `thinking`
  - 输出上限用 `max_completion_tokens`（默认 131072，最大 1048576）
  - `temperature` 固定 1.0、`top_p` 固定 0.95，显式传入可能报错
  - 多轮/工具调用必须回传完整 assistant message（含 `reasoning_content`）
- **K2.6**
  - `thinking: {type: enabled|disabled, keep: all|null}`；本项目开启时使用 `keep: "all"`
  - 关闭思考后不返回 `reasoning_content`
- **K2.7 Code**
  - 始终思考，`thinking.type` 只接受 `enabled`，`keep` 按 `all` 处理
- 缓存：`prompt_cache_key`（本项目传会话 ID），`prompt_tokens_details.cached_tokens` / `cache_write_tokens`
- 用户标识：`safety_identifier`
- 没有 `safety_check`、`title`、DeepSeek web tools
- 视觉：K3 系列支持 `image_url`，还支持 `video_url`

服务端会在 `src/providers.js` 里按上述规则组装请求；前端会按模型能力禁用不适用开关。

---

## 1. 鉴权

### 网页 / 原生接口

- 未设置 `ACCESS_TOKEN`：本机或内网直接可用。
- 设置后：先 `POST /api/login {token}` 换取 `edb_session` HttpOnly Cookie。
- 所有写操作（POST/PATCH/DELETE）必须带请求头：

```http
X-Requested-With: E-dreikanterbot
```

- 同时会校验 `Origin` 为同源（浏览器自动完成）。

### `/v1` 接口

```http
Authorization: Bearer <ACCESS_TOKEN>
```

未设置 `ACCESS_TOKEN` 时 `/v1` 返回 `401`，避免误把无保护的接口暴露到公网。

---

## 2. 原生接口

### 2.1 `POST /api/chat`

请求体：

```json
{
  "conversationId": "c_xxx",
  "message": "你好",
  "images": ["data:image/png;base64,..."],
  "regenerate": false,
  "clientId": "web_xxx",
  "settings": {
    "model": "deepseek-flash",
    "thinking": true,
    "reasoning_effort": "high",
    "max_tokens": 65536,
    "temperature": 1,
    "top_p": 0.95,
    "stop": ["\n\n"],
    "json_mode": false,
    "web_search": false,
    "read_url": false,
    "memory": true,
    "title": true,
    "safety_check": "high",
    "user_id": "web_xxx"
  }
}
```

- `conversationId` 省略则新建会话。
- `images`：最多 4 张，单张 ≤ 8MB，支持 JPEG/PNG/GIF/WebP（按文件头校验）。
- `regenerate: true`：删除末尾助手回复后重跑，不重复写入用户消息。
- `settings` 可省略，服务端使用 `.env` 默认值。

响应：`text/event-stream`，事件如下。

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `meta` | `{requestId, conversationId, model, thinking, tools, estimatedTokens}` | 本轮开始 |
| `reasoning` | `{delta}` | 思考链增量 |
| `content` | `{delta}` | 正文增量 |
| `tool` | `{name, status, summary, args, result}` | 工具执行结果 |
| `memory` | `{count, facts}` | 本轮注入的记忆 |
| `title` | `{title}` | 官方生成的会话标题 |
| `usage` | `{prompt_tokens, completion_tokens, cached_tokens, cost, costDetail, elapsedMs}` | 用量与估算费用 |
| `notice` | `{level, message}` | 非致命提示 |
| `error` | `{status, code, message, hint}` | 上游错误 |
| `done` | `{messageId, finishReason, aborted, elapsedMs}` | 结束 |

示例：

```bash
curl -N http://localhost:8788/api/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: E-dreikanterbot' \
  -H "Cookie: edb_session=..." \
  -d '{"message":"你好","settings":{"thinking":true,"reasoning_effort":"max","max_tokens":4096}}'
```

V2.1.R 的额外字段：

| 字段 | 说明 |
| --- | --- |
| `editMessageId` | 在指定用户消息的同一父节点下创建新分支，旧分支保留 |
| `regenerate: true` | 保留旧回答，在同一用户消息下新建助手兄弟分支 |
| `continue: true` | 插入隐藏续写指令，用于 `finish_reason=length` 或手动停止后续写 |
| `textFiles` | `[{name, text}]`，最多 4 个，单文件 20 万字符、合计 50 万字符 |

消息树字段：每条消息含 `parentId`、`selectedChildId`；会话含 `rootMessageId`。UI 从根沿 `selectedChildId` 取当前路径，切换版本就是改父节点的 `selectedChildId`。隐藏消息（`hidden: true`）用于工具轮次与续写指令，不展示但参与上下文。

### 2.2 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/conversations` | 会话列表（标题、预览、更新时间、用量） |
| POST | `/api/conversations` | 新建空会话 |
| GET | `/api/conversations/:id` | 完整会话（含所有分支与隐藏工具消息） |
| PATCH | `/api/conversations/:id` | 重命名 `{title}` |
| DELETE | `/api/conversations/:id` | 删除会话与附件 |
| GET | `/api/conversations/:id/export?format=md\|json` | 导出当前分支 |
| POST | `/api/conversations/import` | 导入 `{conversations:[...]}` |
| POST | `/api/conversations/:id/select` | 切换分支 `{messageId}` |

### 2.3 记忆库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/memory?q=` | 列表 / 检索 |
| POST | `/api/memory` | 新增 `{text, tags, pinned}` |
| PATCH | `/api/memory/:id` | 修改 / 置顶 |
| DELETE | `/api/memory/:id` | 删除 |
| GET | `/api/memory/export` | 导出全部记忆（JSON 下载） |
| POST | `/api/memory/import` | 导入 `{facts:[...]}`，按文本去重 |

### 2.4 网页读取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/read-url` | `{url}`，抓取公开网页正文；拒绝内网/本机地址，限制 2MB |

### 2.5 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（公开） |
| GET | `/api/config` | 前端配置（不含密钥） |
| GET | `/api/session` | 登录状态 |
| POST | `/api/login` / `/api/logout` | 登录 / 退出 |
| GET | `/api/models` | 双 Provider 模型目录（含上下文/最大输出/能力/是否配置 Key） |
| GET | `/api/balance` | DeepSeek 余额（Kimi 请到 Moonshot 控制台查看） |
| GET | `/api/files/:name` | 读回上传图片（需登录） |

---

## 3. OpenAI 兼容接口

### 3.1 `POST /v1/chat/completions`

与官方请求体一致，额外支持 `stream_options.include_usage`。流式响应原样透传官方 chunk，并以 `data: [DONE]` 结束。

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-flash",
    "messages": [{"role":"user","content":"你好"}],
    "thinking": {"type":"enabled"},
    "reasoning_effort": "high",
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

允许透传的字段：

```text
model, messages, thinking, reasoning_effort, max_tokens, max_completion_tokens,
temperature, top_p, stop, response_format, tools, tool_choice, safety_check,
title, user_id, safety_identifier, prompt_cache_key, logprobs, top_logprobs,
frequency_penalty, presence_penalty
```

- `model` 必须是 `/api/models` 返回的 ID；也支持 `kimi/kimi-k3.1-pro`、`deepseek/deepseek-flash` 前缀写法。
- 非流式请求不会携带 `stream_options`（官方会报 400）。
- 服务端不会自动注入记忆或工具；这是纯代理，适合 SDK / Agent 使用。
- Kimi 模型会自动改写参数（`max_completion_tokens`、移除 `thinking`/`temperature`/`top_p`、限制 `stop` 5 个/32 字节）。

### 3.2 `GET /v1/models`

返回两个模型及 `context_length=1000000`、`max_output_tokens=393216`。

### 3.3 `GET /v1/health`

```json
{ "ok": true, "version": "2.1.0-R", "models": ["deepseek-flash", "deepseek-v4-pro", "kimi-k3.1-pro"] }
```

---

## 4. 官方参数说明与「被忽略」规则

| 参数 | 取值 | 备注 |
| --- | --- | --- |
| `thinking.type` | `enabled` / `disabled` | 省略时默认开启 |
| `reasoning_effort` | `none/low/high/max` | `minimal→low`，`medium/xhigh→high` |
| `max_tokens` | 1–393216 | 非思考默认 8K；思考默认 64K（max effort 128K） |
| `temperature` | 0–2 | **思考模式下无效** |
| `top_p` | (0,1] | flash 非思考固定 1.0；flash 思考下限 0.95；pro 思考忽略 |
| `stop` | 最多 16 个，每个 ≤ 512 字节 | 危险：可能截断 JSON |
| `response_format` | `text` / `json_object` | 使用 JSON 时须在消息中明确要求 JSON |
| `tools` | function / `deepseek_web_search` / `deepseek_read_url` | 思考模式下 `tool_choice=required` 会 400 |
| `safety_check` | `high` / `low` | 公共服务请用 high |
| `title.enabled` | 布尔 | 让官方生成会话标题 |
| `user_id` | ASCII，≤ 512 字节 | 用于缓存隔离与调度 |
| `stream_options.include_usage` | 布尔 | 流式最后一帧带 usage |

**同时启用 web tools / safety_check=high / title 时，官方会忽略：**

```text
temperature, top_p, frequency_penalty, presence_penalty,
stop, seed, n, preserve_thinking, parallel_tool_calls
```

`max_tokens` 仍然有效，但它限制的是每一轮推理的输出，不是整轮总输出。

---

## 5. 错误码

| HTTP | 含义 | 本项目处理 |
| --- | --- | --- |
| 400 | 请求格式错误 | 原样返回 message + hint |
| 401 | API Key 无效 | 提示重新创建 Key |
| 402 | 余额不足 | 提示充值链接 |
| 422 | 参数非法 | 提示查看取值范围 |
| 429 | 限流 | 读取 `Retry-After` 退避重试（最多 2 次） |
| 500/503 | 上游错误 / 过载 | 指数退避重试 |
| 504 | 超时 | 提示稍后重试 |

上游 4xx 不会重试，避免重复计费。

---

## 6. 上下文缓存与费用

官方按前缀命中磁盘缓存，返回：

```json
"usage": {
  "prompt_tokens": 1286,
  "prompt_cache_hit_tokens": 896,
  "prompt_cache_miss_tokens": 390,
  "completion_tokens": 438,
  "total_tokens": 1724
}
```

本项目：

- 保持 system 人设固定、记忆按写入时间排序、日期只精确到天 → 前缀尽量稳定。
- 前端显示缓存命中率、峰谷价与估算费用。
- `title`、web tools、`safety_check=high` 会改变上游计费/参数行为，已按官方文档处理。

估算公式：

```text
input  = hit × cacheHitPrice + miss × cacheMissPrice
output = completion × outputPrice
total  = (input + output) / 1,000,000
```

费用仅供参考，以 DeepSeek 账单为准。
