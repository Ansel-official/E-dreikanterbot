#!/usr/bin/env node
/**
 * 演示模式：本地 mock 上游 + 真实服务端，零 API Key、零费用。
 *   node demo/dev.js
 * 浏览 http://127.0.0.1:8789
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { startMock } from './mock-deepseek.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = await startMock({ port: Number(process.env.MOCK_PORT || 0) });

const { server, cfg, close } = await createApp({
  apiKey: 'demo-key',
  baseUrl: mock.url,
  dataDir: path.join(root, 'data-demo'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8789),
  accessToken: '',
  env: 'demo',
  site: {
    name: 'E-dreikanterbot',
    icpNumber: '',
    icpLink: 'https://beian.miit.gov.cn/',
  },
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`
  演示模式（mock 上游，不调用真实 API）
  ─────────────────────────────────────
  页面    http://${cfg.host}:${cfg.port}
  上游    ${mock.url}
  数据    ${cfg.dataDir}

  提示：发送「介绍一下你的能力」看 Markdown，
        发送「请记住我喜欢深色模式」看记忆工具。
`);
});

async function shutdown() {
  await Promise.allSettled([close(), mock.close()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
