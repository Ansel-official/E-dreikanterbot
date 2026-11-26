import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;

export function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 静态文件服务：ETag、304、gzip、按类型设置缓存策略。
 * 只允许访问 root 内部文件，拒绝路径穿越。
 */
export async function serveStatic(req, res, { root, pathname, searchParams }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const rootWithSep = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      const index = path.join(resolved, 'index.html');
      stat = await fsp.stat(index);
      return sendFile(req, res, index, stat, { pathname, searchParams });
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  return sendFile(req, res, resolved, stat, { pathname, searchParams });
}

async function sendFile(req, res, file, stat, { pathname, searchParams }) {
  const type = contentType(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;

  const isHtml = type.startsWith('text/html');
  const isSw = path.basename(file) === 'sw.js';
  const versioned = searchParams?.has('v');
  let cache = 'public, max-age=3600';
  if (isHtml || isSw) cache = 'no-cache';
  else if (versioned) cache = 'public, max-age=31536000, immutable';

  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }

  let body = await fsp.readFile(file);
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip && body.length > 1024 && COMPRESSIBLE.test(type)) {
    body = await gzip(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
