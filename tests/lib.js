import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { parseSSE } from '../src/deepseek.js';

/* ------------------------------------------------------------------ */
/* 极简测试框架                                                        */
/* ------------------------------------------------------------------ */

export const tests = [];
let context = null;

export function test(name, fn) {
  tests.push({ name, fn });
}

export function setContext(ctx) {
  context = ctx;
}

export function getContext() {
  if (!context) throw new Error('测试上下文尚未初始化');
  return context;
}

export function assert(condition, message = '断言失败') {
  if (!condition) throw new Error(message);
}

export function equal(actual, expected, message = '值不相等') {
  if (actual !== expected) {
    throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function deepEqual(actual, expected, message = '对象不相等') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}：\n  期望 ${b}\n  实际 ${a}`);
}

export function includes(haystack, needle, message = '未包含目标内容') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message}：${JSON.stringify(String(haystack).slice(0, 300))} 不包含 ${JSON.stringify(needle)}`);
  }
}

export function matches(value, regex, message = '未匹配') {
  if (!regex.test(String(value))) throw new Error(`${message}：${JSON.stringify(String(value).slice(0, 200))} 不匹配 ${regex}`);
}

export function throws(fn, message = '应当抛出异常') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

export async function runAll() {
  let pass = 0;
  const failures = [];
  for (const item of tests) {
    const started = Date.now();
    try {
      await item.fn();
      pass += 1;
      console.log(`  \x1b[32m✓\x1b[0m ${item.name} \x1b[2m${Date.now() - started}ms\x1b[0m`);
    } catch (err) {
      failures.push({ name: item.name, err });
      console.log(`  \x1b[31m✗\x1b[0m ${item.name}\n      \x1b[31m${err.message.replace(/\n/g, '\n      ')}\x1b[0m`);
      if (process.env.DEBUG_TESTS) console.error(err);
    }
  }
  console.log('');
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} 项失败\x1b[0m / ${tests.length} 项，通过 ${pass} 项\n`);
    for (const item of failures) console.log(`  ✗ ${item.name}`);
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m：${pass}/${tests.length}\n`);
  }
  return failures.length === 0;
}

/* ------------------------------------------------------------------ */
/* mock DeepSeek 上游                                                  */
/* ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    ...headers,
  });
  res.end(data);
}

function lastUserText(body) {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const msg = body.messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((p) => (p.type === 'text' ? p.text : '[图片]')).join(' ');
    }
  }
  return '';
}

const USAGE = {
  prompt_tokens: 120,
  completion_tokens: 20,
  total_tokens: 140,
  prompt_cache_hit_tokens: 64,
  prompt_cache_miss_tokens: 56,
};

function chunkBase(model) {
  return { id: 'chatcmpl_mock', object: 'chat.completion.chunk', created: 1_700_000_000, model };
}

export async function startMock() {
  const state = { requests: [], kimiRequests: [], failures: [] };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://mock');

      if (req.method === 'GET' && url.pathname === '/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: [
            {
              id: 'deepseek-flash',
              object: 'model',
              owned_by: 'deepseek',
              name: 'DeepSeek-V4.1-Flash',
              context_window: 1_048_576,
              max_output_tokens: 393_216,
              input_modalities: ['text', 'image'],
              effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
            },
            {
              id: 'deepseek-v4-pro',
              object: 'model',
              owned_by: 'deepseek',
              name: 'DeepSeek-V4-Pro',
              context_window: 1_048_576,
              max_output_tokens: 393_216,
              input_modalities: ['text'],
              effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
            },
          ],
        });
      }

      if (req.method === 'GET' && url.pathname === '/kimi/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: [
            { id: 'kimi-k3.1-pro', object: 'model', owned_by: 'moonshot' },
            { id: 'kimi-k3', object: 'model', owned_by: 'moonshot' },
            { id: 'kimi-k2.6', object: 'model', owned_by: 'moonshot' },
          ],
        });
      }

      if (req.method === 'GET' && url.pathname === '/user/balance') {
        return sendJson(res, 200, {
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' },
          ],
        });
      }

      if (req.method === 'POST' && url.pathname === '/kimi/v1/chat/completions') {
        const body = JSON.parse((await readAll(req)) || '{}');
        state.kimiRequests.push(body);
        const text = lastUserText(body);
        if (text.includes('__401__')) {
          return sendJson(res, 401, { error: { message: 'mock kimi invalid key', type: 'invalid_authentication_error' } });
        }
        const kimiUsage = {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 40,
          prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
        };
        if (body.stream === false) {
          return sendJson(res, 200, {
            id: 'chatcmpl_kimi_mock',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '你好，我是 Kimi。', reasoning_content: 'Kimi 思考：这是演示。' },
                finish_reason: 'stop',
              },
            ],
            usage: kimiUsage,
          });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const base = { id: 'chatcmpl_kimi_mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: body.model };
        const sse = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Kimi 思考：' } }] });
        await delay(3);
        sse({ ...base, choices: [{ index: 0, delta: { reasoning_content: '这是演示。' } }] });
        await delay(3);
        sse({ ...base, choices: [{ index: 0, delta: { content: '你好，我是 ' } }] });
        await delay(3);
        sse({ ...base, choices: [{ index: 0, delta: { content: 'Kimi。' } }] });
        await delay(3);
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: kimiUsage });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        const body = JSON.parse(await readAll(req) || '{}');
        state.requests.push(body);
        const text = lastUserText(body);

        if (text.includes('__429__')) {
          return sendJson(res, 429, { error: { message: 'mock rate limit', code: 'rate_limit' } }, { 'Retry-After': '0' });
        }
        if (text.includes('__401__')) {
          return sendJson(res, 401, { error: { message: 'mock invalid key', type: 'authentication_error' } });
        }
        if (text.includes('__402__')) {
          return sendJson(res, 402, { error: { message: 'mock insufficient balance', code: 'insufficient_balance' } });
        }
        if (text.includes('__400__')) {
          return sendJson(res, 400, { error: { message: 'mock bad request', code: 'invalid_format' } });
        }

        const thinking = body.thinking?.type === 'enabled';
        const answer = '你好，我是 E-dreikanterbot。';
        const reasoningText = '让我先想想，这个问题不难。';

        if (body.stream === false) {
          return sendJson(res, 200, {
            id: 'chatcmpl_mock',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: answer,
                  ...(thinking ? { reasoning_content: reasoningText } : {}),
                },
                finish_reason: 'stop',
              },
            ],
            usage: USAGE,
          });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const base = chunkBase(body.model);
        const sse = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

        if (thinking) {
          for (const piece of ['让我先想想，', '这个问题不难。']) {
            sse({ ...base, choices: [{ index: 0, delta: { reasoning_content: piece } }] });
            await delay(2);
          }
        }

        const memoryTool = (body.tools || []).find((t) => t.function?.name === 'remember_fact');
        const alreadyTool = body.messages.some((m) => m.role === 'tool' || m.tool_calls);
        const wantsTool = memoryTool && !alreadyTool && text.includes('记住');

        if (wantsTool) {
          sse({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_mock_1', type: 'function', function: { name: 'remember_fact', arguments: '' } },
                  ],
                },
              },
            ],
          });
          await delay(2);
          sse({
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"用户喜欢深色模式",' } }] } }],
          });
          await delay(2);
          sse({
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"tags":["偏好"]}' } }] } }],
          });
          await delay(2);
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE });
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        for (const piece of [answer.slice(0, 5), answer.slice(5)]) {
          sse({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
          await delay(2);
        }

        const final = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE };
        if (body.title?.enabled) final.choices[0].title = '测试标题';
        sse(final);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      sendJson(res, 404, { error: { message: `mock 未实现 ${req.method} ${url.pathname}` } });
    } catch (err) {
      state.failures.push(err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url,
    state,
    reset() {
      state.requests.length = 0;
      state.kimiRequests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ------------------------------------------------------------------ */
/* 启动被测服务                                                        */
/* ------------------------------------------------------------------ */

export async function startApp(mockUrl, overrides = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edb-test-'));
  const app = await createApp({
    apiKey: 'test-key',
    baseUrl: mockUrl,
    kimiApiKey: 'test-kimi-key',
    kimiBaseUrl: `${mockUrl}/kimi/v1`,
    dataDir,
    accessToken: 'secret-token',
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    timezone: 'Asia/Shanghai',
    safetyLevel: 'high',
    titleEnabled: true,
    webToolsEnabled: false,
    generation: { thinking: true, reasoningEffort: 'high', maxTokens: 4096, temperature: 1, topP: 0.95 },
    memory: { enabled: true, topK: 8, maxChars: 4000 },
    context: { maxTokens: 900_000, maxMessages: 400 },
    rateLimit: { chat: 1000, api: 1000 },
    site: {
      name: 'E-dreikanterbot',
      icpNumber: '京ICP备2026000000号-1',
      icpLink: 'https://beian.miit.gov.cn/',
      policeNumber: '',
    },
    ...overrides,
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    dataDir,
    cleanup: async () => {
      await app.close();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 辅助                                                           */
/* ------------------------------------------------------------------ */

export async function request(base, pathname, options = {}) {
  const { method = 'GET', body, cookie, token, headers = {}, csrf = method !== 'GET' && method !== 'HEAD' } = options;
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (cookie) finalHeaders.cookie = cookie;
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  if (csrf && finalHeaders['x-requested-with'] === undefined) finalHeaders['x-requested-with'] = 'E-dreikanterbot';

  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { res, status: res.status, headers: res.headers, text, json };
}

export async function collectSSE(res) {
  const events = [];
  for await (const event of parseSSE(res.body)) {
    if (event.data === '[DONE]') break;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      data = event.data;
    }
    events.push({ event: event.event, data });
  }
  return events;
}

export function eventData(events, name) {
  return events.filter((e) => e.event === name).map((e) => e.data);
}

export async function login(base, token = 'secret-token') {
  const result = await request(base, '/api/login', { method: 'POST', body: { token } });
  const setCookie = result.headers.get('set-cookie') || '';
  const match = /edb_session=([^;]+)/.exec(setCookie);
  return match ? `edb_session=${match[1]}` : '';
}

export const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function dataUrl(base64 = ONE_PIXEL_PNG, mime = 'image/png') {
  return `data:${mime};base64,${base64}`;
}
