#!/usr/bin/env node
/** 启动前预检：Node 版本、密钥、数据目录、端口、配置。 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';

const checks = [];
function check(name, ok, detail, fatal = true) {
  checks.push({ name, ok, detail, fatal });
}

const major = Number(process.versions.node.split('.')[0]);
check('Node.js 版本', major >= 20, `${process.version}（需要 >= 20）`);

const envFile = path.join(ROOT, '.env');
check('.env 文件', fs.existsSync(envFile), fs.existsSync(envFile) ? envFile : '尚未创建，可 cp .env.example .env');

let cfg;
try {
  cfg = loadConfig();
  check('配置加载', true, `数据目录 ${cfg.dataDir}`);
} catch (err) {
  check('配置加载', false, err.message);
}

if (cfg) {
  check('DEEPSEEK_API_KEY', Boolean(cfg.apiKey), cfg.apiKey ? `已配置（${cfg.apiKey.slice(0, 6)}…）` : '未配置（Kimi 也可以单独使用）', false);
  check('KIMI_API_KEY', Boolean(cfg.kimiApiKey), cfg.kimiApiKey ? '已配置（Moonshot）' : '未配置（仅禁用 Kimi 模型）', false);
  check('至少一个上游 Key', Boolean(cfg.apiKey || cfg.kimiApiKey), cfg.apiKey || cfg.kimiApiKey ? '对话可用' : '缺失，无法对话');
  check('数据目录可写', canWrite(cfg.dataDir), cfg.dataDir);
  check('公网访问保护', !(cfg.host === '0.0.0.0' && !cfg.accessToken), cfg.accessToken ? '已设置 ACCESS_TOKEN' : '监听 0.0.0.0 但未设置 ACCESS_TOKEN', false);
  check('ICP 备案号', Boolean(cfg.site.icpNumber), cfg.site.icpNumber || '未配置（公网部署前需完成备案）', false);
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(file, 'ok');
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function portFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host === '0.0.0.0' ? '127.0.0.1' : host);
  });
}

if (cfg) {
  const free = await portFree(cfg.port, cfg.host);
  check(`端口 ${cfg.port}`, free, free ? '可用' : '被占用，可改 PORT', false);
}

console.log('\nE-dreikanterbot 启动前检查\n');
for (const item of checks) {
  const mark = item.ok ? '\x1b[32m✓\x1b[0m' : item.fatal ? '\x1b[31m✗\x1b[0m' : '\x1b[33m!\x1b[0m';
  console.log(`  ${mark} ${item.name.padEnd(22)} ${item.detail}`);
}
const fatal = checks.filter((c) => !c.ok && c.fatal);
const warnings = checks.filter((c) => !c.ok && !c.fatal);
console.log(`\n结论：${fatal.length ? `\x1b[31m${fatal.length} 项阻塞\x1b[0m` : '\x1b[32m可以启动\x1b[0m'}${warnings.length ? `，${warnings.length} 项提醒` : ''}\n`);
process.exit(fatal.length ? 1 : 0);
