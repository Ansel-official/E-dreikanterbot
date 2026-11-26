import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig, publicConfig } from './config.js';
import { ChatService } from './chat.js';
import { DeepSeekError, chatCompletion, getBalance, streamChatCompletion } from './deepseek.js';
import { readAsDataUrl, saveDataUrl, serveAttachment } from './files.js';
import { PRICING_SOURCE, isPeak } from './pricing.js';
import { ModelRegistry } from './providers.js';
import { serveStatic } from './static.js';
import { readUrl } from './webread.js';
import { ConversationStore, MemoryStore } from './store.js';
import {
  VERSION,
  clientIp,
  fail,
  isAbortError,
  json,
  oneLine,
  parseCookies,
  readJson,
  signSession,
  sseHeaders,
  sseSend,
  timingEqual,
  verifySession,
} from './util.js';

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
].join('; ');

class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.lastPrune = Date.now();
  }

  hit(key, limit, windowMs = 60_000) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
    if (bucket.length >= limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - bucket[0])) / 1000)), remaining: 0 };
    }
    bucket.push(now);
    if (now - this.lastPrune > 60_000) this.prune(now, windowMs);
    return { ok: true, remaining: limit - bucket.length };
  }

  prune(now, windowMs) {
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      if (!bucket.length || now - bucket[bucket.length - 1] > windowMs * 2) this.buckets.delete(key);
    }
  }
}

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const conversations = new ConversationStore({ dir: cfg.conversationsDir });
  await conversations.init();
  const memory = new MemoryStore({ file: cfg.memoryFile, maxChars: cfg.memory.maxChars });
  await memory.init();
  const registry = new ModelRegistry(cfg);
  await registry.init();
  const chat = new ChatService({ cfg, conversations, memory, registry });
  const limiter = new RateLimiter();
  const attachmentCache = new Map();

  const ctx = {
    cfg,
    conversations,
    memory,
    chat,
    registry,
    limiter,
    async resolveAttachment(attachment) {
      const key = attachment?.file;
      if (!key) return null;
      if (attachmentCache.has(key)) return attachmentCache.get(key);
      const url = await readAsDataUrl(cfg.filesDir, attachment);
      if (url) {
        attachmentCache.set(key, url);
        if (attachmentCache.size > 24) attachmentCache.delete(attachmentCache.keys().next().value);
      }
      return url;
    },
  };

  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* noop */
        }
        return;
      }
      const status = err?.status || (err instanceof DeepSeekError ? err.status : 500) || 500;
      if (cfg.env !== 'test') console.error('[E-dreikanterbot]', err?.stack || err);
      fail(res, status >= 400 ? status : 500, err?.code || 'internal_error', err?.message || '服务器内部错误', err?.hint || '');
    });
  });
  server.keepAliveTimeout = 65_000;

  async function close() {
    await Promise.allSettled([conversations.flush(), memory.flush()]);
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, cfg, conversations, memory, chat, registry, close };
}

/* ------------------------------------------------------------------ */
/* 顶层路由                                                            */
/* ------------------------------------------------------------------ */

async function handle(req, res, ctx) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  setSecurityHeaders(req, res, ctx.cfg);

  if (pathname === '/v1' || pathname.startsWith('/v1/')) return handleV1(req, res, url, ctx);
  if (pathname.startsWith('/api/')) return handleApi(req, res, url, ctx);

  return serveStatic(req, res, {
    root: ctx.cfg.publicDir,
    pathname,
    searchParams: url.searchParams,
  });
}

function setSecurityHeaders(req, res, cfg) {
  const preview = cfg.env === 'demo';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', preview ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', preview ? CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : CSP);
  const https =
    Boolean(req.socket?.encrypted) ||
    (cfg.trustProxy > 0 && /https/i.test(String(req.headers['x-forwarded-proto'] || '')));
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/* ------------------------------------------------------------------ */
/* /api/*                                                              */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url, ctx) {
  const { cfg } = ctx;
  const pathname = url.pathname;
  res.setHeader('Cache-Control', 'no-store');

  const auth = authState(req, cfg);

  if (pathname === '/api/health' && req.method === 'GET') {
    const catalog = await ctx.registry.snapshot();
    return json(res, 200, {
      ok: true,
      version: VERSION,
      node: process.version,
      uptime: Math.round(process.uptime()),
      keyConfigured: Boolean(cfg.apiKey || cfg.kimiApiKey),
      model: ctx.registry.effectiveDefaultModel(),
      providers: catalog.providers.map(({ id, name, configured, error }) => ({ id, name, configured, error })),
      conversations: ctx.conversations.list().length,
      memory: ctx.memory.stats(),
      icpConfigured: Boolean(cfg.site.icpNumber),
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const catalog = await ctx.registry.snapshot();
    return json(res, 200, {
      ...publicConfig(cfg, catalog),
      authenticated: auth.authenticated,
      pricing: { source: PRICING_SOURCE, tier: isPeak() ? 'peak' : 'offpeak' },
    });
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    return json(res, 200, auth);
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (!cfg.accessToken) {
      return fail(res, 400, 'login_disabled', '服务端未启用访问密码（ACCESS_TOKEN 为空），无需登录。');
    }
    const limit = ctx.limiter.hit(`login:${clientIp(req, cfg.trustProxy)}`, 10);
    if (!limit.ok) {
      return fail(res, 429, 'rate_limited', '尝试过于频繁，请稍后再试。', `Retry-After: ${limit.retryAfter}s`);
    }
    if (!requireCsrf(req, res)) return;
    const body = await readJson(req, 1024 * 1024);
    const token = String(body.token || '');
    if (!timingEqual(token, cfg.accessToken)) {
      return fail(res, 401, 'invalid_token', '访问密码不正确。');
    }
    const cookie = sessionCookie(req, cfg, signSession(cfg.sessionSecret, cfg.accessToken));
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    if (!requireCsrf(req, res)) return;
    return json(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': 'edb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' },
    );
  }

  if (!auth.authenticated) {
    return fail(res, 401, 'unauthorized', '需要登录后才能访问。', '请使用访问密码登录。');
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !requireCsrf(req, res)) return;

  if (pathname === '/api/models' && req.method === 'GET') {
    const catalog = await ctx.registry.snapshot();
    return json(res, 200, {
      ...catalog,
      data: catalogModels(catalog),
      source: cfg.apiKey || cfg.kimiApiKey ? 'official' : 'static',
      pricing: { source: PRICING_SOURCE, tier: isPeak() ? 'peak' : 'offpeak' },
    });
  }

  if (pathname === '/api/balance' && req.method === 'GET') {
    if (!cfg.apiKey) return fail(res, 503, 'missing_api_key', '服务端未配置 DEEPSEEK_API_KEY。');
    try {
      const data = await getBalance({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeoutMs: 15_000 });
      return json(res, 200, data);
    } catch (err) {
      return fail(res, 502, 'balance_unavailable', `余额查询失败：${err.message}`, err.hint || '');
    }
  }

  if (pathname === '/api/conversations' && req.method === 'GET') {
    return json(res, 200, { data: ctx.conversations.list() });
  }

  if (pathname === '/api/conversations' && req.method === 'POST') {
    const body = await readJson(req, 1024 * 1024);
    const model = ctx.registry.resolve(body.model)?.meta.id || ctx.registry.effectiveDefaultModel();
    const doc = await ctx.conversations.create({ title: oneLine(body.title || '新对话', 80), model });
    return json(res, 201, { data: ctx.conversations.meta(doc) });
  }

  if (pathname === '/api/conversations/import' && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024 * 1024);
    const created = await ctx.conversations.import(body);
    return json(res, 201, { data: created, count: created.length });
  }

  const convMatch = pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)$/);
  if (convMatch) {
    const id = convMatch[1];
    const doc = ctx.conversations.get(id);
    if (!doc) return fail(res, 404, 'not_found', '对话不存在或已被删除。');

    if (req.method === 'GET') return json(res, 200, { data: doc });
    if (req.method === 'PATCH') {
      const body = await readJson(req, 1024 * 1024);
      const meta = await ctx.conversations.update(id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        titleLocked: body.titleLocked === undefined ? undefined : Boolean(body.titleLocked),
      });
      return json(res, 200, { data: meta });
    }
    if (req.method === 'DELETE') {
      const files = doc.messages.flatMap((m) => (m.attachments || []).map((a) => a.file)).filter(Boolean);
      await ctx.conversations.remove(id);
      await Promise.allSettled(files.map((file) => fsp.rm(path.join(cfg.filesDir, path.basename(file)), { force: true })));
      return json(res, 200, { ok: true });
    }
  }

  const selectMatch = pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/select$/);
  if (selectMatch && req.method === 'POST') {
    const id = selectMatch[1];
    if (!ctx.conversations.get(id)) return fail(res, 404, 'not_found', '对话不存在。');
    const body = await readJson(req, 1024 * 1024);
    const doc = await ctx.conversations.selectVersion(id, String(body.messageId || ''));
    if (!doc) return fail(res, 404, 'not_found', '消息版本不存在。');
    return json(res, 200, { data: doc });
  }

  const exportMatch = pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/export$/);
  if (exportMatch && req.method === 'GET') {
    const id = exportMatch[1];
    const doc = ctx.conversations.get(id);
    if (!doc) return fail(res, 404, 'not_found', '对话不存在。');
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
    if (format === 'json') {
      const payload = JSON.stringify({ conversations: [doc] }, null, 2);
      return sendDownload(res, `${safeName(doc.title)}.json`, 'application/json; charset=utf-8', payload);
    }
    const markdown = ctx.conversations.exportMarkdown(id) || '';
    return sendDownload(res, `${safeName(doc.title)}.md`, 'text/markdown; charset=utf-8', markdown);
  }

  if (pathname === '/api/memory' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    return json(res, 200, { data: ctx.memory.list({ query }), stats: ctx.memory.stats() });
  }

  if (pathname === '/api/memory/export' && req.method === 'GET') {
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), facts: ctx.memory.facts }, null, 2);
    return sendDownload(res, `e-dreikanterbot-memory-${new Date().toISOString().slice(0, 10)}.json`, 'application/json; charset=utf-8', payload);
  }

  if (pathname === '/api/memory/import' && req.method === 'POST') {
    const body = await readJson(req, 8 * 1024 * 1024);
    const facts = Array.isArray(body) ? body : body?.facts;
    if (!Array.isArray(facts)) return fail(res, 400, 'invalid_import', '导入文件需要包含 facts 数组');
    let added = 0;
    for (const fact of facts.slice(0, 5000)) {
      if (!fact || typeof fact.text !== 'string' || !fact.text.trim()) continue;
      const result = ctx.memory.add({
        text: fact.text,
        tags: Array.isArray(fact.tags) ? fact.tags : [],
        source: fact.source || 'import',
        pinned: Boolean(fact.pinned),
      });
      if (!result.duplicate) added += 1;
    }
    await ctx.memory.flush();
    return json(res, 200, { ok: true, added, stats: ctx.memory.stats() });
  }

  if (pathname === '/api/memory' && req.method === 'POST') {
    const body = await readJson(req, 1024 * 1024);
    const fact = ctx.memory.add({
      text: body.text,
      tags: body.tags,
      pinned: Boolean(body.pinned),
      source: 'user',
    });
    await ctx.memory.flush();
    return json(res, 201, { data: fact, duplicate: Boolean(fact.duplicate), stats: ctx.memory.stats() });
  }

  const memMatch = pathname.match(/^\/api\/memory\/([A-Za-z0-9_-]+)$/);
  if (memMatch) {
    const id = memMatch[1];
    if (req.method === 'PATCH') {
      const body = await readJson(req, 1024 * 1024);
      const fact = ctx.memory.update(id, body);
      if (!fact) return fail(res, 404, 'not_found', '记忆不存在。');
      await ctx.memory.flush();
      return json(res, 200, { data: fact, stats: ctx.memory.stats() });
    }
    if (req.method === 'DELETE') {
      const ok = ctx.memory.remove(id);
      if (!ok) return fail(res, 404, 'not_found', '记忆不存在。');
      await ctx.memory.flush();
      return json(res, 200, { ok: true, stats: ctx.memory.stats() });
    }
  }

  const fileMatch = pathname.match(/^\/api\/files\/([A-Za-z0-9_.-]+)$/);
  if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveAttachment(req, res, cfg.filesDir, fileMatch[1]);
  }

  if (pathname === '/api/read-url' && req.method === 'POST') {
    const body = await readJson(req, 1024 * 1024);
    try {
      const data = await readUrl(body.url);
      return json(res, 200, { data });
    } catch (err) {
      return fail(res, err.status || 502, 'read_url_failed', err.message || '读取网页失败');
    }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res, ctx);
  }

  return fail(res, 404, 'not_found', `未知接口：${req.method} ${pathname}`);
}

async function handleChat(req, res, ctx) {
  const { cfg, conversations, chat } = ctx;
  if (!cfg.apiKey && !cfg.kimiApiKey) {
    return fail(res, 503, 'missing_api_key', '服务端未配置任何上游 API Key（DEEPSEEK_API_KEY / KIMI_API_KEY）。', '复制 .env.example 为 .env 并填入密钥后重启。');
  }

  const quota = ctx.limiter.hit(`chat:${clientIp(req, cfg.trustProxy)}`, cfg.rateLimit.chat);
  if (!quota.ok) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return fail(res, 429, 'rate_limited', `发送过快，请在 ${quota.retryAfter} 秒后重试。`, '可通过 RATE_LIMIT_CHAT 调整上限。');
  }

  const body = await readJson(req, cfg.maxBodyBytes);
  let settings;
  try {
    settings = chat.normalizeSettings(body.settings || body);
  } catch (err) {
    return fail(res, err.status || 400, err.code || 'invalid_settings', err.message, err.hint || '');
  }
  if (!ctx.registry.isConfigured(settings.provider)) {
    const providerName = settings.modelMeta?.providerName || settings.provider;
    return fail(
      res,
      503,
      'missing_provider_key',
      `${providerName} 尚未配置 API Key`,
      settings.provider === 'kimi' ? '在 .env 设置 KIMI_API_KEY（Moonshot 开放平台）后重启。' : '在 .env 设置 DEEPSEEK_API_KEY 后重启。',
    );
  }
  const images = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 4) : [];
  const textFiles = normalizeTextFiles(body.textFiles);
  if (images.length && !settings.modelMeta.capabilities.vision) {
    return fail(
      res,
      400,
      'model_no_vision',
      `${settings.modelMeta.name} 不支持图片输入`,
      '请切换到支持视觉的模型（deepseek-flash / kimi-k3 系列）。',
    );
  }
  const regenerate = Boolean(body.regenerate);
  const continuing = Boolean(body.continue);
  const editMessageId = body.editMessageId ? String(body.editMessageId) : null;

  let conversation = null;
  let created = false;
  if (body.conversationId) {
    conversation = conversations.get(String(body.conversationId));
    if (!conversation) return fail(res, 404, 'not_found', '对话不存在。');
  }

  let message = '';
  let attachments = [];
  if (regenerate) {
    if (!conversation) return fail(res, 400, 'invalid_request', '重新生成需要提供 conversationId。');
    const path = conversations.visiblePath(conversation);
    const lastUser = [...path].reverse().find((m) => m.role === 'user');
    const last = path[path.length - 1];
    if (!lastUser || last?.role !== 'assistant') {
      return fail(res, 400, 'nothing_to_regenerate', '没有可重新生成的回答。');
    }
    // 保留旧回答作为兄弟分支，新建助手分支。
    await conversations.clearSelectedChild(conversation.id, lastUser.id);
  } else if (continuing) {
    if (!conversation) return fail(res, 400, 'invalid_request', '继续生成需要提供 conversationId。');
    const path = conversations.visiblePath(conversation);
    const last = path[path.length - 1];
    if (!last || last.role !== 'assistant') {
      return fail(res, 400, 'nothing_to_continue', '当前没有可续写的回答。');
    }
    await conversations.append(
      conversation.id,
      {
        role: 'user',
        content: '（系统续写指令）请从上次中断处继续，直接续写正文，不要重复已经输出的内容，也不要重新开头。',
        hidden: true,
        internal: true,
      },
      { parentId: last.id },
    );
  } else {
    message = String(body.message ?? '').trim();
    if (!message && !images.length) return fail(res, 400, 'empty_message', '消息不能为空。');
    if (message.length > 100_000) return fail(res, 413, 'message_too_long', '单条消息不能超过 10 万字符。');

    if (!conversation) {
      conversation = await conversations.create({
        title: oneLine(message || '图片对话', 24) || '新对话',
        model: settings.model,
      });
      created = true;
    }

    let editTarget = null;
    if (editMessageId) {
      editTarget = conversation.messages.find((item) => item.id === editMessageId && item.role === 'user');
      if (!editTarget) return fail(res, 400, 'invalid_edit', '要编辑的用户消息不存在。');
    }

    try {
      for (const dataUrl of images) {
        attachments.push(await saveDataUrl(dataUrl, cfg.filesDir, { maxBytes: 8 * 1024 * 1024 }));
      }
    } catch (err) {
      if (created) await conversations.remove(conversation.id).catch(() => {});
      throw err;
    }

    await conversations.append(
      conversation.id,
      {
        role: 'user',
        content: message,
        attachments: attachments.length ? attachments : undefined,
        files: textFiles.length ? textFiles : undefined,
        clientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : undefined,
      },
      editTarget ? { parentId: editTarget.parentId ?? null } : {},
    );
  }

  res.writeHead(200, sseHeaders());
  res.flushHeaders?.();

  const upstream = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      upstream.abort(new Error('client_closed'));
    }
  };
  res.on('close', onClose);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* noop */
      }
    }
  }, 15_000);
  heartbeat.unref?.();

  const emit = (event, data) => {
    if (clientGone) return;
    try {
      sseSend(res, event, data);
    } catch {
      clientGone = true;
      upstream.abort(new Error('client_gone'));
    }
  };

  try {
    const result = await chat.run({
      conversation,
      settings,
      signal: upstream.signal,
      emit,
      attachmentResolver: ctx.resolveAttachment,
    });
    if (result.finishReason === 'insufficient_system_resource') {
      emit('notice', { level: 'warning', message: '推理资源不足，回答被中断。可以重试或缩短上下文。' });
    }
  } catch (err) {
    if (isAbortError(err) || clientGone) {
      emit('done', { aborted: true, finishReason: 'aborted' });
    } else {
      const status = err?.status || 502;
      emit('error', {
        status,
        code: err?.code || 'upstream_error',
        message: err?.message || '上游请求失败',
        hint: err?.hint || '',
      });
    }
  } finally {
    clearInterval(heartbeat);
    res.removeListener('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容 /v1/*                                                   */
/* ------------------------------------------------------------------ */

async function handleV1(req, res, url, ctx) {
  const { cfg } = ctx;
  const pathname = url.pathname;
  setCors(res, cfg);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (!cfg.accessToken) {
    return openaiError(res, 401, '未启用对外接口：请先在 .env 设置 ACCESS_TOKEN 并重启。', 'configuration_error');
  }

  const bearer = parseBearer(req);
  if (!bearer || !timingEqual(bearer, cfg.accessToken)) {
    return openaiError(res, 401, 'Invalid API key. 使用服务端 ACCESS_TOKEN 作为 Bearer Token。', 'authentication_error');
  }

  const limit = ctx.limiter.hit(`v1:${bearer.slice(0, 8)}:${clientIp(req, cfg.trustProxy)}`, cfg.rateLimit.api);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return openaiError(res, 429, 'Rate limit reached. 请稍后重试。', 'rate_limit_error');
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    const catalog = await ctx.registry.snapshot();
    return json(res, 200, { object: 'list', data: catalogModels(catalog), providers: catalog.providers });
  }

  if (pathname === '/v1/health' && req.method === 'GET') {
    const catalog = await ctx.registry.snapshot();
    return json(res, 200, {
      ok: true,
      version: VERSION,
      models: catalog.models.map((model) => model.id),
      providers: catalog.providers.map(({ id, name, configured }) => ({ id, name, configured })),
    });
  }

  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readJson(req, cfg.maxBodyBytes);
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return openaiError(res, 400, 'messages 必须是非空数组。', 'invalid_request_error');
    }

    const requested = body.model || ctx.registry.effectiveDefaultModel();
    const resolved = ctx.registry.resolve(requested);
    if (!resolved) {
      const catalog = await ctx.registry.snapshot();
      return openaiError(
        res,
        400,
        `不支持的模型：${requested}。可选：${catalog.models.map((model) => model.id).join(' / ')}`,
        'invalid_request_error',
      );
    }
    if (!ctx.registry.isConfigured(resolved.provider)) {
      return openaiError(
        res,
        503,
        `${resolved.meta.providerName} 尚未配置 API Key`,
        'configuration_error',
        'missing_provider_key',
      );
    }

    const payload = adaptOpenAIPayload(pickOpenAIFields(body), resolved);
    payload.model = resolved.meta.id;

    const apiOptions = {
      apiKey: ctx.registry.apiKeyFor(resolved.provider),
      baseUrl: ctx.registry.baseUrlFor(resolved.provider),
      timeoutMs: cfg.upstreamTimeoutMs,
    };

    if (!body.stream) {
      try {
        const result = await chatCompletion(payload, apiOptions);
        return json(res, 200, result);
      } catch (err) {
        return openaiUpstreamError(res, err);
      }
    }

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('client_closed'));
    };
    res.on('close', onClose);
    res.writeHead(200, sseHeaders());

    try {
      for await (const chunk of streamChatCompletion(payload, { ...apiOptions, signal: controller.signal })) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (err) {
      if (!res.writableEnded && !isAbortError(err)) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: err.message,
              type: 'upstream_error',
              code: err.code || 'api_error',
              provider: resolved.provider,
              hint: err.hint || '',
            },
          })}\n\n`,
        );
      }
    } finally {
      res.removeListener('close', onClose);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  return openaiError(res, 404, `未知接口：${req.method} ${pathname}`, 'not_found_error');
}

function pickOpenAIFields(body) {
  const allowed = [
    'messages',
    'thinking',
    'reasoning_effort',
    'max_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'stop',
    'response_format',
    'tools',
    'tool_choice',
    'safety_check',
    'title',
    'user_id',
    'safety_identifier',
    'prompt_cache_key',
    'logprobs',
    'top_logprobs',
    'frequency_penalty',
    'presence_penalty',
    'stream_options',
  ];
  const payload = { stream: Boolean(body.stream) };
  for (const key of allowed) if (body[key] !== undefined) payload[key] = body[key];
  if (payload.stream) payload.stream_options = { ...(body.stream_options || {}), include_usage: true };
  else delete payload.stream_options;
  return payload;
}

/** 按 Provider 的官方参数约束调整 OpenAI 兼容请求。 */
function adaptOpenAIPayload(payload, resolved) {
  const { provider, meta } = resolved;

  if (provider === 'deepseek') {
    if (payload.max_completion_tokens !== undefined && payload.max_tokens === undefined) {
      payload.max_tokens = payload.max_completion_tokens;
    }
    delete payload.max_completion_tokens;
    delete payload.prompt_cache_key;
    delete payload.safety_identifier;
    return payload;
  }

  // Kimi：max_tokens 已弃用；采样参数固定；K3 不接受 thinking。
  if (payload.max_tokens !== undefined && payload.max_completion_tokens === undefined) {
    payload.max_completion_tokens = payload.max_tokens;
  }
  delete payload.max_tokens;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.frequency_penalty;
  delete payload.presence_penalty;
  delete payload.safety_check;
  delete payload.title;

  if (payload.user_id) {
    payload.safety_identifier = payload.user_id;
    delete payload.user_id;
  }
  if (meta.thinking.mode === 'always') delete payload.thinking;
  if (!meta.thinking.efforts.length) delete payload.reasoning_effort;

  if (Array.isArray(payload.stop)) {
    payload.stop = payload.stop
      .map((item) => String(item))
      .filter((item) => item && Buffer.byteLength(item, 'utf8') <= 32)
      .slice(0, 5);
    if (!payload.stop.length) delete payload.stop;
  } else if (typeof payload.stop === 'string') {
    if (Buffer.byteLength(payload.stop, 'utf8') > 32) payload.stop = payload.stop.slice(0, 32);
  }

  return payload;
}

function openaiError(res, status, message, type, code = '') {
  return json(res, status, { error: { message, type, code: code || type, param: null } });
}

function openaiUpstreamError(res, err) {
  if (err instanceof DeepSeekError) {
    return json(res, err.status || 502, {
      error: { message: err.message, type: 'upstream_error', code: err.code, hint: err.hint },
    });
  }
  return openaiError(res, 502, err.message || '上游请求失败', 'upstream_error');
}

function catalogModels(catalog) {
  const created = 1_735_689_600;
  return (catalog?.models || []).map((model) => ({
    id: model.id,
    object: 'model',
    created,
    owned_by: model.provider,
    name: model.name,
    context_length: model.contextWindow,
    max_output_tokens: model.maxOutput,
    input_modalities: model.inputModalities,
    capabilities: model.capabilities,
  }));
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function authState(req, cfg) {
  if (!cfg.accessToken) return { required: false, authenticated: true };
  const cookies = parseCookies(req.headers.cookie);
  const ok = verifySession(cookies.edb_session, cfg.sessionSecret, cfg.accessToken);
  return { required: true, authenticated: ok };
}

function requireCsrf(req, res) {
  if (String(req.headers['x-requested-with'] || '') !== 'E-dreikanterbot') {
    fail(res, 403, 'csrf_rejected', '缺少 X-Requested-With 请求头。');
    return false;
  }
  return true;
}

function sessionCookie(req, cfg, value) {
  const secure =
    Boolean(req.socket?.encrypted) ||
    (cfg.trustProxy > 0 && /https/i.test(String(req.headers['x-forwarded-proto'] || '')));
  return `edb_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
    secure ? '; Secure' : ''
  }`;
}

function setCors(res, cfg) {
  res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin || '*');
  res.setHeader('Vary', 'Origin');
}

function parseBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function sendDownload(res, filename, type, content) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

function safeName(value) {
  return String(value || 'conversation')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .slice(0, 60) || 'conversation';
}

/** 文本附件：最多 4 个，单个 200k 字符，总计 500k 字符。 */
function normalizeTextFiles(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const files = [];
  let total = 0;
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item.text !== 'string') continue;
    const text = item.text;
    if (!text.trim()) continue;
    if (text.length > 200_000) {
      const error = new Error(`附件 ${item.name || ''} 超过 20 万字符`);
      error.status = 413;
      throw error;
    }
    total += text.length;
    if (total > 500_000) {
      const error = new Error('文本附件总长度超过 50 万字符');
      error.status = 413;
      throw error;
    }
    files.push({ name: String(item.name || 'attachment').slice(0, 80), text, size: text.length });
  }
  return files;
}

export { RateLimiter, catalogModels };
