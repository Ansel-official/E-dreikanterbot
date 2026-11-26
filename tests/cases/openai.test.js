import { assert, collectSSE, equal, getContext, includes, request, test } from '../lib.js';

export default function register() {
  const AUTH = { token: 'secret-token' };

  test('/v1 鉴权：缺失或错误 Bearer 均 401', async () => {
    const { base } = getContext();
    const none = await request(base, '/v1/models');
    equal(none.status, 401);
    equal(none.json.error.type, 'authentication_error');

    const wrong = await request(base, '/v1/models', { token: 'nope' });
    equal(wrong.status, 401);
  });

  test('/v1/models：返回官方模型列表', async () => {
    const { base } = getContext();
    const res = await request(base, '/v1/models', AUTH);
    equal(res.status, 200);
    equal(res.json.object, 'list');
    const ids = res.json.data.map((m) => m.id);
    assert(ids.includes('deepseek-flash'));
    assert(ids.includes('deepseek-v4-pro'));
    equal(res.json.data[0].context_length, 1_000_000);
    equal(res.json.data[0].max_output_tokens, 393_216);
  });

  test('/v1/chat/completions 非流式：透传思考内容与 usage', async () => {
    const { base, mock } = getContext();
    mock.reset();
    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      ...AUTH,
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
        max_tokens: 512,
        temperature: 0.7,
        thinking: { type: 'enabled' },
      },
    });
    equal(res.status, 200);
    equal(res.json.object, 'chat.completion');
    equal(res.json.choices[0].message.content, '你好，我是 E-dreikanterbot。');
    includes(res.json.choices[0].message.reasoning_content, '先想想');
    equal(res.json.usage.prompt_tokens, 120);

    const upstream = mock.state.requests.at(-1);
    equal(upstream.stream, false);
    equal(upstream.max_tokens, 512);
    equal(upstream.temperature, 0.7);
    equal(upstream.thinking.type, 'enabled');
    assert(!upstream.stream_options, '非流式不应携带 stream_options');
  });

  test('/v1/chat/completions 流式：标准 data 事件与 [DONE]', async () => {
    const { base, mock } = getContext();
    mock.reset();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      }),
    });
    equal(res.status, 200);
    includes(res.headers.get('content-type'), 'text/event-stream');

    const events = await collectSSE(res);
    assert(events.length >= 3, `应有多个 chunk，实际 ${events.length}`);
    const text = events
      .map((e) => e.data.choices?.[0]?.delta?.content || '')
      .join('');
    equal(text, '你好，我是 E-dreikanterbot。');
    const last = events.at(-1).data;
    equal(last.usage.prompt_tokens, 120);
    equal(last.usage.total_tokens, 140);

    const upstream = mock.state.requests.at(-1);
    equal(upstream.stream, true);
    equal(upstream.stream_options.include_usage, true);
  });

  test('/v1/chat/completions：未知模型与缺失 messages 被拒绝', async () => {
    const { base } = getContext();
    const badModel = await request(base, '/v1/chat/completions', {
      method: 'POST',
      ...AUTH,
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    });
    equal(badModel.status, 400);
    includes(badModel.json.error.message, '不支持的模型');

    const noMessages = await request(base, '/v1/chat/completions', {
      method: 'POST',
      ...AUTH,
      body: { model: 'deepseek-flash', messages: [] },
    });
    equal(noMessages.status, 400);
  });

  test('/v1/chat/completions：上游 402 原样映射', async () => {
    const { base } = getContext();
    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      ...AUTH,
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '__402__' }] },
    });
    equal(res.status, 402);
    includes(res.json.error.message, 'insufficient balance');
  });

  test('/v1 CORS 预检：允许 Authorization 与 POST', async () => {
    const { base } = getContext();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    equal(res.status, 204);
    equal(res.headers.get('access-control-allow-origin'), '*');
    includes(res.headers.get('access-control-allow-headers'), 'Authorization');
    includes(res.headers.get('access-control-allow-methods'), 'POST');
  });
}
