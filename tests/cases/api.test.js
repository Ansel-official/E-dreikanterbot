import {
  assert,
  collectSSE,
  dataUrl,
  equal,
  eventData,
  getContext,
  includes,
  request,
  test,
} from '../lib.js';

export default function register() {
  test('健康检查与公开配置：不下发密钥', async () => {
    const { base } = getContext();
    const health = await request(base, '/api/health');
    equal(health.status, 200);
    assert(health.json.keyConfigured, '应报告密钥已配置');
    assert(!health.text.includes('test-key'), '健康检查不应泄露 API Key');
    assert(!health.text.includes('secret-token'), '健康检查不应泄露访问密码');

    const config = await request(base, '/api/config');
    equal(config.status, 200);
    equal(config.json.site.icpNumber, '京ICP备2026000000号-1');
    equal(config.json.defaultModel, 'deepseek-flash');
    assert(!JSON.stringify(config.json).includes('test-key'));
    assert(!JSON.stringify(config.json).includes('secret-token'));
    equal(config.json.features.login, true);
    assert(!config.json.sessionSecret, '不应下发会话密钥');
  });

  test('鉴权：未登录 401、错误密码 401、登录后可用、CSRF 校验', async () => {
    const { base, cookie } = getContext();
    const unauth = await request(base, '/api/conversations');
    equal(unauth.status, 401);
    equal(unauth.json.error.code, 'unauthorized');

    const badLogin = await request(base, '/api/login', { method: 'POST', body: { token: 'wrong' } });
    equal(badLogin.status, 401);

    const ok = await request(base, '/api/conversations', { cookie });
    equal(ok.status, 200);
    assert(Array.isArray(ok.json.data));

    const noCsrf = await request(base, '/api/conversations', { method: 'POST', body: {}, cookie, csrf: false });
    equal(noCsrf.status, 403);
    equal(noCsrf.json.error.code, 'csrf_rejected');

    const session = await request(base, '/api/session', { cookie });
    equal(session.json.authenticated, true);
    equal(session.json.required, true);
  });

  test('原生流式对话：meta/reasoning/content/usage/title/done 全链路', async () => {
    const { base, cookie, mock } = getContext();
    mock.reset();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ message: '你好', settings: { max_tokens: 1024 } }),
    });
    equal(res.status, 200);
    includes(res.headers.get('content-type'), 'text/event-stream');

    const events = await collectSSE(res);
    const names = events.map((e) => e.event);
    assert(names.includes('meta'), '应收到 meta');
    assert(names.includes('reasoning'), '应收到 reasoning');
    assert(names.includes('content'), '应收到 content');
    assert(names.includes('usage'), '应收到 usage');
    assert(names.includes('title'), '应收到 title');
    assert(names.includes('done'), '应收到 done');

    const meta = eventData(events, 'meta')[0];
    equal(meta.model, 'deepseek-flash');
    equal(meta.thinking, true);
    assert(meta.conversationId.startsWith('c_'), '会话 ID 前缀');

    const content = eventData(events, 'content').map((d) => d.delta).join('');
    equal(content, '你好，我是 E-dreikanterbot。');
    const reasoning = eventData(events, 'reasoning').map((d) => d.delta).join('');
    includes(reasoning, '先想想');

    const usage = eventData(events, 'usage')[0];
    equal(usage.prompt_cache_hit_tokens, 64);
    equal(usage.completion_tokens, 20);
    assert(usage.cost > 0, '应估算出费用');
    assert(usage.elapsedMs >= 0);

    const done = eventData(events, 'done')[0];
    assert(done.messageId, 'done 应带消息 ID');
    equal(done.aborted, false);

    const last = mock.state.requests.at(-1);
    equal(last.thinking.type, 'enabled');
    equal(last.reasoning_effort, 'high');
    equal(last.max_tokens, 1024);
    equal(last.safety_check.level, 'high');
    equal(last.stream_options.include_usage, true);
    equal(last.title.enabled, true);
    assert(last.user_id.startsWith('edb_'), '应带 user_id');

    const detail = await request(base, `/api/conversations/${meta.conversationId}`, { cookie });
    equal(detail.status, 200);
    equal(detail.json.data.title, '测试标题');
    equal(detail.json.data.messages.length, 2);
    equal(detail.json.data.messages[1].content, content);
    equal(detail.json.data.messages[1].thinking, true);
    assert(detail.json.data.messages[1].usage.cost > 0);
  });

  test('记忆工具：模型调用 remember_fact 后写入并回传 reasoning/tool', async () => {
    const { base, cookie, mock } = getContext();
    mock.reset();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ message: '请记住我喜欢深色模式', settings: { max_tokens: 2048 } }),
    });
    equal(res.status, 200);
    const events = await collectSSE(res);
    const tools = eventData(events, 'tool');
    assert(tools.length >= 1, '应有工具事件');
    equal(tools[0].name, 'remember_fact');
    includes(tools[0].summary, '已记住');

    equal(mock.state.requests.length, 2, '工具调用应产生两轮上游请求');
    const second = mock.state.requests[1];
    const assistant = second.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    assert(assistant, '第二轮应携带 assistant.tool_calls');
    assert(typeof assistant.reasoning_content === 'string', '带工具时必须回传 reasoning_content');
    assert(second.messages.some((m) => m.role === 'tool'), '第二轮应携带 tool 结果');

    const memory = await request(base, '/api/memory', { cookie });
    const fact = memory.json.data.find((f) => f.text.includes('深色模式'));
    assert(fact, '记忆库中应存在该事实');
    equal(fact.source, 'model');

    const meta = eventData(events, 'meta')[0];
    const detail = await request(base, `/api/conversations/${meta.conversationId}`, { cookie });
    equal(detail.json.data.messages.length, 4, '用户 + 隐藏工具轮 + 最终回答');
    assert(detail.json.data.messages[1].hidden, '中间助手消息应隐藏');
    assert(detail.json.data.messages[2].hidden, 'tool 消息应隐藏');
  });

  test('重新生成：不重复写入用户消息', async () => {
    const { base, cookie, mock } = getContext();
    mock.reset();
    const first = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ message: '你好，重新生成测试' }),
    });
    const firstEvents = await collectSSE(first);
    const conversationId = eventData(firstEvents, 'meta')[0].conversationId;

    const again = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ conversationId, regenerate: true }),
    });
    equal(again.status, 200);
    const events = await collectSSE(again);
    assert(eventData(events, 'content').length > 0, '应重新生成内容');
    equal(eventData(events, 'done')[0].aborted, false);

    const detail = await request(base, `/api/conversations/${conversationId}`, { cookie });
    equal(detail.json.data.messages.length, 2, '重新生成后消息数不变');
    equal(detail.json.data.messages[0].role, 'user');
    equal(detail.json.data.messages[1].role, 'assistant');
  });

  test('图片输入：保存附件、上游收到 image_url、可回读', async () => {
    const { base, cookie, mock } = getContext();
    mock.reset();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ message: '看看这张图', images: [dataUrl()] }),
    });
    equal(res.status, 200);
    const events = await collectSSE(res);
    const conversationId = eventData(events, 'meta')[0].conversationId;
    equal(eventData(events, 'content').length > 0, true);

    const detail = await request(base, `/api/conversations/${conversationId}`, { cookie });
    const user = detail.json.data.messages[0];
    equal(user.attachments.length, 1);
    equal(user.attachments[0].mime, 'image/png');

    const upstream = mock.state.requests.at(-1);
    const lastUser = [...upstream.messages].reverse().find((m) => m.role === 'user');
    assert(Array.isArray(lastUser.content), '上游应收到内容数组');
    assert(lastUser.content.some((part) => part.type === 'image_url'), '应包含 image_url');

    const file = await request(base, `/api/files/${user.attachments[0].file}`, { cookie });
    equal(file.status, 200);
    equal(file.headers.get('content-type'), 'image/png');
  });

  test('图片校验：伪造文件头返回 415 且不留下空会话', async () => {
    const { base, cookie } = getContext();
    const before = await request(base, '/api/conversations', { cookie });
    const res = await request(base, '/api/chat', {
      method: 'POST',
      cookie,
      body: { message: '坏图', images: ['data:image/png;base64,QUJD'] },
    });
    equal(res.status, 415);
    includes(res.json.error.message, '文件头');
    const after = await request(base, '/api/conversations', { cookie });
    equal(after.json.data.length, before.json.data.length);
  });

  test('上游错误：402 以 SSE error 事件返回并带提示', async () => {
    const { base, cookie } = getContext();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ message: '__402__' }),
    });
    equal(res.status, 200, '流式响应已建立');
    const events = await collectSSE(res);
    const error = eventData(events, 'error')[0];
    assert(error, '应收到 error 事件');
    equal(error.status, 402);
    includes(error.hint, '余额');
  });

  test('记忆库 API：增查改删', async () => {
    const { base, cookie } = getContext();
    const created = await request(base, '/api/memory', {
      method: 'POST',
      cookie,
      body: { text: '用户叫小明，常用中文交流', tags: '身份,偏好' },
    });
    equal(created.status, 201);
    const id = created.json.data.id;
    equal(created.json.data.tags.length, 2);

    const list = await request(base, '/api/memory?q=' + encodeURIComponent('小明'), { cookie });
    assert(list.json.data.some((f) => f.id === id), '检索应命中');

    const patched = await request(base, `/api/memory/${id}`, {
      method: 'PATCH',
      cookie,
      body: { pinned: true, text: '用户叫小明' },
    });
    equal(patched.status, 200);
    equal(patched.json.data.pinned, true);
    equal(patched.json.data.text, '用户叫小明');

    const removed = await request(base, `/api/memory/${id}`, { method: 'DELETE', cookie });
    equal(removed.status, 200);
    const list2 = await request(base, '/api/memory', { cookie });
    assert(!list2.json.data.some((f) => f.id === id), '删除后不应存在');
  });

  test('会话导出 Markdown 与删除', async () => {
    const { base, cookie } = getContext();
    const created = await request(base, '/api/conversations', { method: 'POST', cookie, body: { title: '导出会话' } });
    const id = created.json.data.id;
    const res = await fetch(`${base}/api/conversations/${id}/export?format=md`, { headers: { cookie } });
    equal(res.status, 200);
    includes(res.headers.get('content-disposition'), 'attachment');
    const text = await res.text();
    includes(text, '# 导出会话');

    const removed = await request(base, `/api/conversations/${id}`, { method: 'DELETE', cookie });
    equal(removed.status, 200);
    const missing = await request(base, `/api/conversations/${id}`, { cookie });
    equal(missing.status, 404);
  });

  test('模型与余额：官方数据，未知模型被过滤', async () => {
    const { base, cookie } = getContext();
    const models = await request(base, '/api/models', { cookie });
    equal(models.status, 200);
    equal(models.json.source, 'official');
    const ids = models.json.data.map((m) => m.id);
    assert(ids.includes('deepseek-flash'));
    assert(!ids.includes('other-model'), '应过滤掉非官方模型');

    const balance = await request(base, '/api/balance', { cookie });
    equal(balance.status, 200);
    equal(balance.json.is_available, true);
  });

  test('安全响应头与路径穿越防护', async () => {
    const { base } = getContext();
    const res = await fetch(`${base}/api/health`);
    equal(res.headers.get('x-frame-options'), 'DENY');
    includes(res.headers.get('content-security-policy'), "default-src 'self'");
    equal(res.headers.get('x-content-type-options'), 'nosniff');

    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    assert([403, 404].includes(traversal.status), `路径穿越应被拒绝，实际 ${traversal.status}`);
  });
}
