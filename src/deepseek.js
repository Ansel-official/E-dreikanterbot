import { parseRetryAfter, sleep, VERSION } from './util.js';

/** 官方错误码：https://api-docs.deepseek.com/quick_start/error_codes */
const HINTS = {
  400: '请求格式不正确。请检查 thinking / reasoning_effort / max_tokens / messages 的结构。',
  401: '上游 API Key 无效或已过期（DeepSeek / Kimi 需分别配置），请检查 .env 与平台密钥。',
  402: '账户余额不足，请到对应平台充值（DeepSeek 或 Moonshot）。',
  408: '请求超时，请检查网络后重试。',
  413: '请求体过大，请压缩图片或减少上下文。',
  422: '参数取值不合法，请参考 docs/API.md 中的取值范围。',
  429: '触发限流：请求过快或并发超限，请降低频率后重试。',
  500: 'DeepSeek 服务端错误，稍后重试。',
  503: 'DeepSeek 服务过载，稍后重试。',
  504: '网关超时，稍后重试。',
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class DeepSeekError extends Error {
  constructor(status, payload = {}, raw = '') {
    const info = payload?.error ?? payload ?? {};
    const message =
      (typeof info === 'object' && info.message) ||
      (typeof info === 'string' && info) ||
      raw ||
      `DeepSeek API 返回 HTTP ${status}`;
    super(String(message).slice(0, 800));
    this.name = 'DeepSeekError';
    this.status = Number(status) || 0;
    this.code = (typeof info === 'object' && info && info.code) || (typeof info === 'object' && info && info.type) || 'api_error';
    this.type = (typeof info === 'object' && info && info.type) || '';
    this.hint = this.status ? HINTS[this.status] || '请参考 DeepSeek 官方错误码文档。' : '请检查网络与 DEEPSEEK_BASE_URL。';
  }

  toJSON() {
    return { status: this.status, code: this.code, type: this.type, message: this.message, hint: this.hint };
  }
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `E-dreikanterbot/${VERSION}`,
  };
}

/**
 * 发起请求（只在建立连接阶段重试，流式响应中途不重试，避免重复输出）。
 */
async function connect(pathname, options = {}) {
  const {
    method = 'POST',
    body,
    apiKey,
    baseUrl = 'https://api.deepseek.com',
    signal,
    timeoutMs = 10 * 60 * 1000,
    fetchImpl = fetch,
    retries = 2,
  } = options;

  if (!apiKey) {
    throw new DeepSeekError(503, {
      error: { message: '服务端未配置 DEEPSEEK_API_KEY', code: 'missing_api_key' },
    });
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${pathname}`;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    if (signal) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('upstream_timeout'));
    }, timeoutMs);

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: authHeaders(apiKey),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal?.aborted) throw err;
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt, signal);
        continue;
      }
      if (timedOut) {
        throw new DeepSeekError(504, {
          error: { message: `连接 DeepSeek API 超时（${timeoutMs}ms）`, code: 'upstream_timeout' },
        });
      }
      throw new DeepSeekError(0, {
        error: { message: `无法连接 DeepSeek API：${err.message}`, code: 'network_error' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { message: text.slice(0, 500) || `HTTP ${res.status}` } };
    }

    if (RETRYABLE.has(res.status) && attempt < retries && !signal?.aborted) {
      const wait = parseRetryAfter(res.headers.get('retry-after')) || 500 * 2 ** attempt;
      await sleep(Math.min(wait, 10_000), signal);
      continue;
    }
    throw new DeepSeekError(res.status, payload, text);
  }
}

/**
 * 解析 SSE。返回 { event, data }，自动处理 CRLF、多行 data、注释心跳。
 * @param {AsyncIterable<Uint8Array|string>} source
 */
export async function* parseSSE(source) {
  const decoder = new TextDecoder();
  let buffer = '';

  const drain = function* (final = false) {
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseEvent(raw);
      if (event) yield event;
    }
    if (final && buffer.trim()) {
      const event = parseEvent(buffer);
      buffer = '';
      if (event) yield event;
    }
  };

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
}

function parseEvent(raw) {
  const data = [];
  let event = 'message';
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/**
 * 流式 Chat Completions。逐块 yield 原始 chunk 对象。
 * @returns {AsyncGenerator<object>}
 */
export async function* streamChatCompletion(payload, options = {}) {
  const res = await connect('/chat/completions', { ...options, body: payload });
  const stream = res.body;
  if (!stream) throw new DeepSeekError(502, { error: { message: '上游未返回响应流' } });

  for await (const event of parseSSE(stream)) {
    if (event.data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (chunk?.error) throw new DeepSeekError(res.status, chunk);
    yield chunk;
  }
}

/** 非流式 Chat Completions（供 /v1 兼容接口使用）。 */
export async function chatCompletion(payload, options = {}) {
  const res = await connect('/chat/completions', { ...options, body: { ...payload, stream: false } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DeepSeekError(502, { error: { message: '上游返回了非 JSON 响应' } }, text);
  }
  if (data?.error) throw new DeepSeekError(res.status, data);
  return data;
}

/** 官方模型列表 GET /models */
export async function listModels(options = {}) {
  const res = await connect('/models', { ...options, method: 'GET', retries: 1 });
  return res.json();
}

/** 账户余额 GET /user/balance */
export async function getBalance(options = {}) {
  const res = await connect('/user/balance', { ...options, method: 'GET', retries: 1 });
  return res.json();
}
