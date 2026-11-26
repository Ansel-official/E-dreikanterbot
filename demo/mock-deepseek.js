#!/usr/bin/env node
/**
 * 演示用 mock 上游：完整模拟 DeepSeek Chat Completions 的流式协议。
 * 不调用真实 API、不产生费用，仅用于本地预览与录屏。
 */
import http from 'node:http';

const USAGE = {
  prompt_tokens: 1286,
  completion_tokens: 438,
  total_tokens: 1724,
  prompt_cache_hit_tokens: 896,
  prompt_cache_miss_tokens: 390,
};

const RICH_ANSWER = [
  '### 你好，我是 E-dreikanterbot',
  '',
  '一个**按 DeepSeek 官方 API 原样实现**的聊天机器人。你看到的每个字，都来自官方 `/chat/completions` 的流式响应。',
  '',
  '| 能力 | 官方参数 |',
  '| --- | --- |',
  '| 深度思考 | `thinking` + `reasoning_effort` |',
  '| 超长输出 | `max_tokens` 最高 393216 |',
  '| 长期记忆 | 工具调用 + 本地记忆库 |',
  '| 图片理解 | `image_url` 多模态 |',
  '',
  '调用方式与官方完全一致：',
  '',
  '```js',
  "const res = await fetch('https://api.deepseek.com/chat/completions', {",
  "  method: 'POST',",
  "  headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },",
  '  body: JSON.stringify({',
  "    model: 'deepseek-flash',",
  "    messages: [{ role: 'user', content: '你好' }],",
  "    thinking: { type: 'enabled' },",
  '  }),',
  '});',
  '```',
  '',
  '想试试记忆库？对我说「**请记住我喜欢深色模式**」，我会调用 `remember_fact` 写进去。',
].join('\n');

const SIMPLE_ANSWER =
  '收到。这是一个**演示回复**：当前连接的是本地 mock 上游，不会调用真实 DeepSeek API，也不产生费用。\n\n' +
  '在 `.env` 填入 `DEEPSEEK_API_KEY` 并重启后，就会得到真实回答。';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part) => (part.type === 'text' ? part.text : '[图片]')).join(' ');
    }
  }
  return '';
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMock({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');

    if (req.method === 'GET' && url.pathname === '/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        ],
      });
    }

    if (req.method === 'GET' && url.pathname === '/user/balance') {
      return sendJson(res, 200, {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '88.00', granted_balance: '0.00', topped_up_balance: '88.00' },
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

    if (req.method === 'POST' && url.pathname === '/kimi/v1/chat/completions') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { error: { message: 'invalid json' } });
      }
      const text = lastUserText(body.messages);
      const kimiAnswer = /能力|介绍|你是谁|可以做什么/.test(text)
        ? [
            '你好，我是 **Kimi K3.1 Pro**（本地 demo 模拟）。',
            '',
            'Kimi 的 K3 系列与 DeepSeek 的参数习惯不同：',
            '',
            '- 始终开启思考，用顶层 `reasoning_effort` 调节强度，不接受 `thinking`',
            '- 输出上限用 `max_completion_tokens`，最高 1M',
            '- `temperature` / `top_p` 固定，不应显式传入',
            '- 缓存会返回 `prompt_tokens_details.cache_write_tokens`',
            '',
            '```json',
            '{"model":"kimi-k3.1-pro","reasoning_effort":"max","max_completion_tokens":131072}',
            '```',
          ].join('\n')
        : '你好，我是 Kimi K3.1 Pro（demo 模拟）。当前是本地 mock 上游，不会产生真实费用。';
      const reasoning = 'Kimi 正在思考：识别到这是一次演示请求，需要展示 K3 系列的思考流与回答。';
      const usage = {
        prompt_tokens: 108,
        completion_tokens: 36,
        total_tokens: 144,
        cached_tokens: 32,
        prompt_tokens_details: { cached_tokens: 32, cache_write_tokens: 12 },
      };
      const base = { id: 'chatcmpl_kimi_demo', object: 'chat.completion.chunk', created: 1_764_000_000, model: body.model };

      if (body.stream === false) {
        return sendJson(res, 200, {
          id: 'chatcmpl_kimi_demo',
          object: 'chat.completion',
          created: 1_764_000_000,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: kimiAnswer, reasoning_content: reasoning }, finish_reason: 'stop' }],
          usage,
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      for (const piece of reasoning.match(/[\s\S]{1,16}/g) || []) {
        send({ ...base, choices: [{ index: 0, delta: { reasoning_content: piece } }] });
        await delay(16);
      }
      for (const piece of kimiAnswer.match(/[\s\S]{1,12}/g) || []) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
        await delay(20);
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ ...base, choices: [], usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { error: { message: 'invalid json' } });
      }

      const text = lastUserText(body.messages);
      const thinking = body.thinking?.type === 'enabled';
      const wantsMemory = /记住|记得/.test(text) && !body.messages.some((m) => m.role === 'tool' || m.tool_calls);
      const answer = /能力|介绍|你是谁|可以做什么/.test(text) ? RICH_ANSWER : SIMPLE_ANSWER;
      const reasoning = [
        '先判断用户意图：这是一个演示请求，需要展示流式输出、思考面板和 Markdown 渲染。',
        '然后组织回答结构：先给结论，再列能力表，最后给一段可运行代码。',
        '注意引用官方参数名，避免编造不存在的字段。',
      ].join('\n');
      const base = { id: 'chatcmpl_demo', object: 'chat.completion.chunk', created: 1_764_000_000, model: body.model };

      if (body.stream === false) {
        return sendJson(res, 200, {
          id: 'chatcmpl_demo',
          object: 'chat.completion',
          created: 1_764_000_000,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: answer,
                ...(thinking ? { reasoning_content: reasoning } : {}),
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
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (thinking) {
        for (const piece of reasoning.match(/[\s\S]{1,18}/g) || []) {
          send({ ...base, choices: [{ index: 0, delta: { reasoning_content: piece } }] });
          await delay(18);
        }
      }

      if (wantsMemory) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_demo_1', type: 'function', function: { name: 'remember_fact', arguments: '' } },
                ],
              },
            },
          ],
        });
        await delay(120);
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"text":"用户偏好深色模式，喜欢先给结论再解释",' } },
                ],
              },
            },
          ],
        });
        await delay(120);
        send({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"tags":["偏好","界面"]}' } }] } }],
        });
        await delay(200);
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      for (const piece of answer.match(/[\s\S]{1,14}/g) || []) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
        await delay(22);
      }

      const final = {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', title: 'E-dreikanterbot 能力介绍' }],
        usage: USAGE,
      };
      send(final);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    sendJson(res, 404, { error: { message: `mock 未实现 ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    server,
    url: `http://${host}:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && process.argv[1].endsWith('mock-deepseek.js')) {
  const mock = await startMock({ port: Number(process.env.MOCK_PORT || 8899) });
  console.log(`mock DeepSeek 上游已启动：${mock.url}`);
}
