import { login, runAll, setContext, startApp, startMock } from './lib.js';

let mock;
let app;

try {
  console.log('\n  E-dreikanterbot 测试\n');
  mock = await startMock();
  app = await startApp(mock.url);
  const cookie = await login(app.base);
  setContext({ mock, app: app.app, base: app.base, cookie, dataDir: app.dataDir });

  for (const name of ['core', 'store', 'api', 'openai']) {
    const module = await import(`./cases/${name}.test.js`);
    module.default();
  }
} catch (err) {
  console.error('测试初始化失败：', err);
  process.exitCode = 1;
}

const ok = await runAll();
await app?.cleanup();
await mock?.close();
process.exit(ok ? 0 : 1);
