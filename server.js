#!/usr/bin/env node
import os from 'node:os';
import { createApp } from './src/app.js';

const { server, cfg, close } = await createApp();

function lanUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${cfg.port}`);
    }
  }
  return urls;
}

server.listen(cfg.port, cfg.host, () => {
  const local = `http://localhost:${cfg.port}`;
  const lines = [
    '',
    '  \x1b[1mE-dreikanterbot\x1b[0m  \x1b[2mv1.0.0\x1b[0m',
    '  ─────────────────────────────────────────────',
    `  本机访问   ${local}`,
  ];
  if (cfg.host === '0.0.0.0') {
    for (const url of lanUrls()) lines.push(`  局域网     ${url}`);
  }
  lines.push(
    `  数据目录   ${cfg.dataDir}`,
    `  默认模型   ${cfg.defaultModel}`,
    `  API Key    ${cfg.apiKey ? '已配置' : '\x1b[33m未配置（无法对话）\x1b[0m'}`,
    `  访问密码   ${cfg.accessToken ? '已启用' : '未设置'}`,
    `  ICP 备案   ${cfg.site.icpNumber || '\x1b[33m未配置\x1b[0m'}`,
    '  ─────────────────────────────────────────────',
  );
  if (!cfg.apiKey) {
    lines.push('  下一步：cp .env.example .env，填入 DEEPSEEK_API_KEY 后重启。');
  }
  if (cfg.host === '0.0.0.0' && !cfg.accessToken) {
    lines.push('  \x1b[33m提示：正在监听所有网卡且未设置 ACCESS_TOKEN，公网部署前请务必设置。\x1b[0m');
  }
  if (!cfg.site.icpNumber) {
    lines.push('  \x1b[33m提示：公网提供服务前需完成 ICP 备案，见 docs/ICP.md。\x1b[0m');
  }
  lines.push('  按 Ctrl+C 停止。', '');
  console.log(lines.join('\n'));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在保存数据并退出…`);
  const timer = setTimeout(() => process.exit(1), 8000);
  timer.unref();
  try {
    await close();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
