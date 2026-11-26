# API 文档

本文对应 **DeepSeek 官方 Chat Completions API**（模型 `deepseek-flash` / `deepseek-v4-pro`）。官方文档：<https://api-docs.deepseek.com/api/create-chat-completion>。

E-dreikanterbot 提供两套接口：

1. **原生接口** `/api/*`：给网页使用，事件流更细（思考、工具、用量、标题分开推送）。
2. **OpenAI 兼容接口** `/v1/*`：给 SDK / 第三方客户端使用，请求与响应格式与官方一致。

---

## 0. 上游与模型

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.deepseek.com` |
| Chat Completions | `POST /chat/completions` |
| 模型 | `deepseek-flash`（V4.1 Flash）、`deepseek-v4-pro`（V4 Pro） |
| 上下文 | 1,000,000 tokens |
| 最大输出 | 393,216 tokens（384K） |
| 思考模式 | 默认开启，effort 默认 `high` |

官方计价（美元 / 1M tokens，2026-11 文档）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- |
| deepseek-flash | $0.003 / $0.006（谷/峰） | $0.15 / $0.30 | $0.6 / $1.2 |
| deepseek-v4-pro | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

高峰：UTC 周一至周五 01:00–04:00、06:00–10:00；其余为低峰（节假日未在本地判定）。

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

### 2.2 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/conversations` | 会话列表（标题、预览、更新时间、用量） |
| POST | `/api/conversations` | 新建空会话 |
| GET | `/api/conversations/:id` | 完整会话（含隐藏的工具消息） |
| PATCH | `/api/conversations/:id` | 重命名 `{title}` |
| DELETE | `/api/conversations/:id` | 删除会话与附件 |
| GET | `/api/conversations/:id/export?format=md\|json` | 导出 |
| POST | `/api/conversations/import` | 导入 `{conversations:[...]}` |

### 2.3 记忆库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/memory?q=` | 列表 / 检索 |
| POST | `/api/memory` | 新增 `{text, tags, pinned}` |
| PATCH | `/api/memory/:id` | 修改 / 置顶 |
| DELETE | `/api/memory/:id` | 删除 |

### 2.4 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（公开） |
| GET | `/api/config` | 前端配置（不含密钥） |
| GET | `/api/session` | 登录状态 |
| POST | `/api/login` / `/api/logout` | 登录 / 退出 |
| GET | `/api/models` | 官方模型列表（服务端代查） |
| GET | `/api/balance` | 官方余额 |
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
model, messages, thinking, reasoning_effort, max_tokens, temperature, top_p,
stop, response_format, tools, tool_choice, safety_check, title, user_id,
logprobs, top_logprobs, frequency_penalty, presence_penalty
```

- `model` 仅接受 `deepseek-flash` / `deepseek-v4-pro`。
- 非流式请求不会携带 `stream_options`（官方会报 400）。
- 服务端不会自动注入记忆或工具；这是纯代理，适合 SDK / Agent 使用。

### 3.2 `GET /v1/models`

返回两个模型及 `context_length=1000000`、`max_output_tokens=393216`。

### 3.3 `GET /v1/health`

```json
{ "ok": true, "version": "1.0.0", "models": ["deepseek-flash", "deepseek-v4-pro"] }
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
