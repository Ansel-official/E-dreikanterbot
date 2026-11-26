import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, readBody } from './util.js';

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function mimeForFile(file) {
  const ext = path.extname(String(file || '')).slice(1).toLowerCase();
  return IMAGE_MIME[ext] || 'application/octet-stream';
}

export function extForMime(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] || null;
}

/** 按文件头判断真实图片类型（官方同样是按内容判断，不看后缀）。 */
export function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * 保存 data URL 图片到 data/files，返回可持久化的附件描述。
 * @returns {Promise<{id:string,mime:string,size:number,file:string}>}
 */
export async function saveDataUrl(dataUrl, dir, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof dataUrl !== 'string') {
    const err = new Error('图片格式不正确');
    err.status = 400;
    throw err;
  }
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) {
    const err = new Error('只支持 base64 编码的 data URL 图片');
    err.status = 400;
    throw err;
  }
  const declared = match[1].toLowerCase();
  if (!extForMime(declared)) {
    const err = new Error('仅支持 JPEG / PNG / GIF / WebP 图片');
    err.status = 415;
    throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > maxBytes) {
    const err = new Error(`单张图片不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    err.status = 413;
    throw err;
  }
  const mime = detectImageMime(buffer);
  if (!mime) {
    const err = new Error('无法识别的图片内容（文件头校验失败）');
    err.status = 415;
    throw err;
  }
  const id = newId('img');
  const file = `${id}.${extForMime(mime)}`;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, file), buffer);
  return { id, mime, size: buffer.length, file };
}

/** 把已保存附件读成 data URL，供上游多模态请求使用。 */
export async function readAsDataUrl(dir, attachment) {
  if (!attachment?.file) return null;
  const safe = path.basename(attachment.file);
  try {
    const buffer = await fsp.readFile(path.join(dir, safe));
    return `data:${attachment.mime || mimeForFile(safe)};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/** 受控地发送附件（仅允许 data/files 下的图片，防止路径穿越）。 */
export async function serveAttachment(req, res, dir, name) {
  const safe = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/i.test(safe)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const buffer = await fsp.readFile(path.join(dir, safe));
    res.writeHead(200, {
      'Content-Type': mimeForFile(safe),
      'Content-Length': buffer.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buffer);
  } catch {
    res.writeHead(404).end();
  }
}

export async function listAttachmentFiles(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

export { readBody };
