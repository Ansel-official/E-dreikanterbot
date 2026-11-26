import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, equal, includes, test } from '../lib.js';
import { ConversationStore, MemoryStore, tokenize } from '../../src/store.js';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'edb-store-'));
}

export default function register() {
  test('会话存储：创建、追加、列表、重载', async () => {
    const dir = await tempDir();
    try {
      const store = new ConversationStore({ dir });
      await store.init();
      const doc = await store.create({ title: '第一条对话', model: 'deepseek-flash' });
      await store.append(doc.id, { role: 'user', content: '你好' });
      await store.append(doc.id, {
        role: 'assistant',
        content: '你好呀',
        reasoning: '思考中',
        thinking: true,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 2 },
      });

      const list = store.list();
      equal(list.length, 1);
      equal(list[0].messageCount, 2);
      equal(list[0].preview, '你好');
      equal(list[0].usage.prompt_tokens, 10);

      const reloaded = new ConversationStore({ dir });
      await reloaded.init();
      equal(reloaded.get(doc.id).messages.length, 2);
      equal(reloaded.get(doc.id).messages[1].reasoning, '思考中');

      const meta = await store.update(doc.id, { title: '改名了' });
      equal(meta.title, '改名了');
      equal(store.get(doc.id).titleLocked, true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('会话存储：重新生成时只删除末尾助手消息', async () => {
    const dir = await tempDir();
    try {
      const store = new ConversationStore({ dir });
      await store.init();
      const doc = await store.create({});
      await store.append(doc.id, { role: 'user', content: 'Q1' });
      await store.append(doc.id, { role: 'assistant', content: 'A1' });
      await store.append(doc.id, { role: 'assistant', content: '', hidden: true, toolCalls: [{ id: 'c1' }] });
      await store.append(doc.id, { role: 'tool', content: '{}', hidden: true });

      const removed = await store.popTrailingAssistant(doc.id);
      assert(removed, '应当删除末尾助手消息');
      equal(store.get(doc.id).messages.length, 1);
      equal(store.get(doc.id).messages[0].content, 'Q1');
      equal(await store.popTrailingAssistant(doc.id), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('会话导出 Markdown 与 JSON 导入', async () => {
    const dir = await tempDir();
    try {
      const store = new ConversationStore({ dir });
      await store.init();
      const doc = await store.create({ title: '导出测试' });
      await store.append(doc.id, { role: 'user', content: '问题' });
      await store.append(doc.id, { role: 'assistant', content: '答案', reasoning: '推理' });

      const md = store.exportMarkdown(doc.id);
      includes(md, '# 导出测试');
      includes(md, '## 用户');
      includes(md, '思考过程');
      includes(md, '答案');

      const created = await store.import({
        conversations: [
          {
            title: '导入的对话',
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: 'yo' },
              { role: 'tool', content: 'ignored' },
            ],
          },
        ],
      });
      equal(created.length, 1);
      equal(created[0].messageCount, 2);
      assert(store.get(created[0].id), '导入后应可读取');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('会话分支：编辑产生兄弟版本，选择后可见路径切换', async () => {
    const dir = await tempDir();
    try {
      const store = new ConversationStore({ dir });
      await store.init();
      const doc = await store.create({});
      const user = await store.append(doc.id, { role: 'user', content: '第一问' });
      const first = await store.append(doc.id, { role: 'assistant', content: '第一答' });
      const second = await store.append(
        doc.id,
        { role: 'assistant', content: '第二答' },
        { parentId: user.id },
      );

      equal(store.visiblePath(doc).length, 2);
      equal(store.visiblePath(doc)[1].id, second.id, '新回答应成为当前分支');
      equal(store.meta(doc).messageCount, 2);
      equal(store.meta(doc).totalMessages, 3);

      await store.selectVersion(doc.id, first.id);
      equal(store.visiblePath(doc)[1].id, first.id, '切换版本后应显示旧回答');
      equal(store.visiblePath(doc).length, 2);

      await store.clearSelectedChild(doc.id, user.id);
      equal(store.visiblePath(doc).length, 1, '取消选中后路径止于用户消息');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('会话存储：删除文件后列表消失', async () => {
    const dir = await tempDir();
    try {
      const store = new ConversationStore({ dir });
      await store.init();
      const doc = await store.create({});
      equal(store.list().length, 1);
      equal(await store.remove(doc.id), true);
      equal(store.list().length, 0);
      equal(await store.remove('c_not_exist_123'), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('长期记忆：写入、去重、检索、持久化', async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, 'memory.json');
      const memory = new MemoryStore({ file, maxChars: 4000 });
      await memory.init();

      const a = memory.add({ text: '用户偏好用 TypeScript 写代码', tags: ['偏好'] });
      const b = memory.add({ text: '用户在开发 Dreikanter 图片编辑器', tags: ['项目'] });
      const dup = memory.add({ text: '用户偏好用 TypeScript 写代码' });
      assert(dup.duplicate, '重复记忆应被识别');
      equal(memory.stats().count, 2);

      const results = memory.search('TypeScript 偏好', 5);
      equal(results[0].id, a.id);
      const results2 = memory.search('Dreikanter', 5);
      equal(results2[0].id, b.id);

      const block = memory.buildBlock({ query: '', topK: 2, maxChars: 4000 });
      includes(block.text, '<memory>');
      includes(block.text, 'TypeScript');
      assert(block.text.indexOf(a.text) < block.text.indexOf(b.text), '应按写入时间升序，保证前缀稳定');

      await memory.flush();
      const reloaded = new MemoryStore({ file, maxChars: 4000 });
      await reloaded.init();
      equal(reloaded.stats().count, 2);

      reloaded.update(b.id, { pinned: true, tags: ['项目', '重点'] });
      equal(reloaded.list().find((f) => f.id === b.id).pinned, true);
      equal(reloaded.remove(a.id), true);
      equal(reloaded.stats().count, 1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('长期记忆：中文分词与字符上限', async () => {
    const tokens = tokenize('用户喜欢深色模式 DeepSeek');
    assert(tokens.includes('深色'), '应包含中文双字词');
    assert(tokens.includes('deepseek'), '应包含英文词');

    const dir = await tempDir();
    try {
      const memory = new MemoryStore({ file: path.join(dir, 'memory.json'), maxChars: 120 });
      await memory.init();
      for (let i = 0; i < 10; i += 1) memory.add({ text: `事实${i}：` + '细节'.repeat(20) });
      const block = memory.buildBlock({ query: '', topK: 10, maxChars: 200 });
      assert(block.text.length <= 260, `记忆块应受上限约束，实际 ${block.text.length}`);
      assert(block.facts.length < 10, '不应注入全部事实');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
}
