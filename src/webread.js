import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export class WebReadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WebReadError';
    this.status = status;
  }
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
    return true;
  }
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (net.isIP(host) === 4) return isPrivateIpv4(host);
  if (net.isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebReadError(400, '链接格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new WebReadError(400, '只支持 http / https 链接');
  }
  if (isPrivateHostname(url.hostname)) {
    throw new WebReadError(403, '禁止读取内网或本机地址');
  }
  if (net.isIP(url.hostname) === 0) {
    let addresses;
    try {
      addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new WebReadError(502, `无法解析域名：${url.hostname}`);
    }
    if (!addresses.length || addresses.some((entry) => isPrivateHostname(entry.address))) {
      throw new WebReadError(403, '域名解析到内网地址，已拒绝');
    }
  }
  return url;
}

async function readLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        throw new WebReadError(413, '网页内容超过 2MB 限制');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    copy: '©',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  return { title, text };
}

export async function readUrl(rawUrl) {
  let current = await assertPublicUrl(String(rawUrl || '').trim());
  let response = null;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'E-dreikanterbot/2.1 (+https://github.com/Ansel-official/E-dreikanterbot)',
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    break;
  }

  if (!response) throw new WebReadError(502, '读取网页失败');
  if (!response.ok) throw new WebReadError(response.status === 404 ? 404 : 502, `目标网页返回 HTTP ${response.status}`);

  const type = String(response.headers.get('content-type') || '');
  if (type && !/text\/|html|json|xml|markdown/i.test(type)) {
    throw new WebReadError(415, `不支持的内容类型：${type.split(';')[0]}`);
  }

  const body = await readLimited(response);
  const parsed = type.includes('html') || /<html[\s>]/i.test(body) ? htmlToText(body) : { title: '', text: body.trim() };
  const text = parsed.text.slice(0, 100_000);

  return {
    url: current.href,
    title: parsed.title || current.hostname,
    text,
    truncated: parsed.text.length > text.length,
    chars: text.length,
  };
}
