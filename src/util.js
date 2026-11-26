import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

export function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function fail(res, status, code, message, hint = '') {
  json(res, status, { error: { code, message, hint } });
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`请求体超过上限 ${limit} 字节`);
        err.status = 413;
        err.code = 'payload_too_large';
        done(reject, err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => done(reject, err));
  });
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是 JSON 对象');
      err.status = 400;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    const bad = new Error('请求体不是合法的 JSON');
    bad.status = 400;
    bad.code = 'invalid_json';
    throw bad;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function clientIp(req, trustProxy = 0) {
  if (trustProxy > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return xff[Math.min(trustProxy - 1, xff.length - 1)] || xff[0];
    const real = req.headers['x-real-ip'];
    if (real) return String(real);
  }
  return (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

export function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

export function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = payload.split('\n').map((line) => `data: ${line}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Auth / crypto                                                       */
/* ------------------------------------------------------------------ */

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 生成签名会话值：v1.<过期时间戳>.<签名> */
export function signSession(secret, accessToken, ttlMs = 30 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const body = `v1.${exp}.${sha256(accessToken).slice(0, 16)}`;
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

export function verifySession(value, secret, accessToken) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const [v, exp, tag, sig] = parts;
  const numExp = Number(exp);
  if (!Number.isFinite(numExp) || numExp < Date.now()) return false;
  if (tag !== sha256(accessToken).slice(0, 16)) return false;
  const body = `${v}.${exp}.${tag}`;
  const expect = createHmac('sha256', secret).update(body).digest('hex');
  return timingEqual(sig, expect);
}

/* ------------------------------------------------------------------ */
/* Filesystem                                                          */
/* ------------------------------------------------------------------ */

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半个 JSON。 */
export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, data, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      // 坏文件不阻塞启动，备份后返回 fallback
      await fsp.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(value, max, suffix = '…') {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function oneLine(value, max = 80) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.message === 'aborted');
}

export function safeFilename(name, fallback = 'file') {
  const base = path.basename(String(name || '')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 80) || fallback;
}
