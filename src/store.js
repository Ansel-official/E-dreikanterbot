import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, ensureDir, newId, oneLine, readJsonFile, safeFilename } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export function isConversationId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/* ================================================================== */
/* 会话存储：一条会话一个 JSON 文件，写入串行化 + 原子替换            */
/* ================================================================== */

export class ConversationStore {
  constructor({ dir }) {
    this.dir = dir;
    this.cache = new Map();
    this.queues = new Map();
  }

  async init() {
    await ensureDir(this.dir);
    const files = await fsp.readdir(this.dir).catch(() => []);
    await Promise.all(
      files
        .filter((name) => name.endsWith('.json') && !name.includes('.corrupt-'))
        .map(async (name) => {
          const doc = await readJsonFile(path.join(this.dir, name), null);
          if (doc && isConversationId(doc.id) && Array.isArray(doc.messages)) {
            this.cache.set(doc.id, doc);
          }
        }),
    );
  }

  meta(doc) {
    const path = this.visiblePath(doc).filter((message) => !message.hidden);
    const last = path[path.length - 1];
    const lastUser = [...path].reverse().find((m) => m.role === 'user');
    return {
      id: doc.id,
      title: doc.title || '新对话',
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt || doc.createdAt,
      model: doc.model || '',
      messageCount: path.length,
      totalMessages: doc.messages.length,
      preview: oneLine(lastUser?.content || last?.content || '', 60),
      titleLocked: Boolean(doc.titleLocked),
      usage: doc.totalUsage || null,
    };
  }

  /** 旧数据没有 rootMessageId：按原顺序补全 parentId/selectedChildId（仅内存，下一次写入时落盘）。 */
  _normalize(doc) {
    if (doc.rootMessageId !== undefined) return doc;
    doc.rootMessageId = doc.messages[0]?.id ?? null;
    doc.messages.forEach((message, index) => {
      if (message.parentId === undefined) message.parentId = doc.messages[index - 1]?.id ?? null;
      if (message.selectedChildId === undefined) message.selectedChildId = doc.messages[index + 1]?.id;
    });
    return doc;
  }

  /**
   * 当前选中分支的完整路径（含隐藏的工具消息）。
   * 旧会话没有分支字段时按原顺序返回。
   */
  visiblePath(doc) {
    if (!doc) return [];
    if (doc.rootMessageId === undefined) return [...doc.messages];
    const byId = new Map(doc.messages.map((message) => [message.id, message]));
    const path = [];
    const seen = new Set();
    let id = doc.rootMessageId;
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const message = byId.get(id);
      path.push(message);
      id = message.selectedChildId ?? null;
    }
    return path;
  }

  /** 给 UI 使用的可见路径（过滤隐藏工具消息）。 */
  visibleMessages(doc, { includeHidden = false } = {}) {
    const path = this.visiblePath(doc);
    return includeHidden ? path : path.filter((message) => !message.hidden);
  }

  list() {
    return [...this.cache.values()]
      .map((doc) => this.meta(doc))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    return isConversationId(id) ? this.cache.get(id) || null : null;
  }

  async create({ title = '新对话', model = 'deepseek-flash' } = {}) {
    const now = new Date().toISOString();
    const doc = {
      id: newId('c'),
      title,
      model,
      createdAt: now,
      updatedAt: now,
      titleLocked: false,
      rootMessageId: null,
      messages: [],
      totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cost: 0 },
    };
    this.cache.set(doc.id, doc);
    await this._persist(doc);
    return doc;
  }

  /**
   * 追加消息。默认挂在当前可见路径末尾；传 parentId 可创建分支。
   * 新消息会成为父节点当前选中的子节点。
   */
  async append(id, message, { parentId } = {}) {
    const doc = this.get(id);
    if (!doc) return null;
    this._normalize(doc);
    const path = this.visiblePath(doc);
    const parent = parentId === undefined ? path[path.length - 1]?.id ?? null : parentId;
    const msg = {
      id: newId('m'),
      createdAt: new Date().toISOString(),
      ...message,
      parentId: parent,
    };
    doc.messages.push(msg);
    if (parent === null) {
      doc.rootMessageId = msg.id;
    } else {
      const parentMessage = doc.messages.find((item) => item.id === parent);
      if (parentMessage) parentMessage.selectedChildId = msg.id;
    }
    doc.updatedAt = msg.createdAt;
    if (message.usage) this._accumulateUsage(doc, message.usage);
    await this._persist(doc);
    return msg;
  }

  /** 重新生成前：把父节点当前选中的子分支取消，下一次 append 会成为新的兄弟版本。 */
  async clearSelectedChild(id, messageId) {
    const doc = this.get(id);
    if (!doc) return false;
    this._normalize(doc);
    const message = doc.messages.find((item) => item.id === messageId);
    if (!message) return false;
    message.selectedChildId = undefined;
    doc.updatedAt = new Date().toISOString();
    await this._persist(doc);
    return true;
  }

  /** 切换消息版本：选择 messageId 作为其父节点的当前子分支。 */
  async selectVersion(id, messageId) {
    const doc = this.get(id);
    if (!doc) return null;
    this._normalize(doc);
    const message = doc.messages.find((item) => item.id === messageId);
    if (!message) return null;
    if (message.parentId === null || message.parentId === undefined) {
      doc.rootMessageId = message.id;
    } else {
      const parent = doc.messages.find((item) => item.id === message.parentId);
      if (!parent) return null;
      parent.selectedChildId = message.id;
    }
    doc.updatedAt = new Date().toISOString();
    await this._persist(doc);
    return doc;
  }

  /** 收集某个父节点下的兄弟版本（用于 UI 的 1/2 切换）。 */
  siblingsOf(doc, message) {
    return doc.messages
      .filter((item) => (item.parentId ?? null) === (message.parentId ?? null))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async update(id, patch = {}) {
    const doc = this.get(id);
    if (!doc) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) {
      doc.title = oneLine(patch.title, 80);
      if (patch.titleLocked !== undefined) doc.titleLocked = Boolean(patch.titleLocked);
      else doc.titleLocked = true;
    }
    if (typeof patch.model === 'string') doc.model = patch.model;
    if (patch.titleLocked !== undefined) doc.titleLocked = Boolean(patch.titleLocked);
    doc.updatedAt = new Date().toISOString();
    await this._persist(doc);
    return this.meta(doc);
  }

  async remove(id) {
    const doc = this.get(id);
    if (!doc) return false;
    this.cache.delete(id);
    await fsp.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  /** 重新生成：删除末尾的助手回复（含隐藏的工具消息），保留最后一条用户消息。 */
  async popTrailingAssistant(id) {
    const doc = this.get(id);
    if (!doc || !doc.messages.length) return false;
    let removed = false;
    while (doc.messages.length && doc.messages[doc.messages.length - 1].role !== 'user') {
      doc.messages.pop();
      removed = true;
    }
    if (!removed) return false;
    doc.updatedAt = new Date().toISOString();
    await this._persist(doc);
    return true;
  }

  _accumulateUsage(doc, usage) {
    const total = doc.totalUsage || (doc.totalUsage = {});
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']) {
      total[key] = (Number(total[key]) || 0) + (Number(usage[key]) || 0);
    }
    if (usage.cost) total.cost = Math.round(((Number(total.cost) || 0) + Number(usage.cost)) * 1e6) / 1e6;
  }

  async _persist(doc) {
    const run = () => atomicWrite(path.join(this.dir, `${doc.id}.json`), JSON.stringify(doc, null, 2));
    const prev = this.queues.get(doc.id) || Promise.resolve();
    const next = prev.then(run, run);
    const guard = next.catch(() => {});
    this.queues.set(doc.id, guard);
    guard.finally(() => {
      if (this.queues.get(doc.id) === guard) this.queues.delete(doc.id);
    });
    await next;
  }

  async flush() {
    await Promise.allSettled([...this.queues.values()]);
  }

  exportMarkdown(id) {
    const doc = this.get(id);
    if (!doc) return null;
    const lines = [`# ${doc.title}`, '', `> 模型：${doc.model || '未知'} · 创建：${doc.createdAt}`, ''];
    for (const msg of this.visiblePath(doc)) {
      if (msg.hidden) continue;
      if (msg.role === 'user') {
        lines.push('## 用户', '', msg.content || '（图片）', '');
        if (msg.attachments?.length) {
          lines.push(`> 附件 ${msg.attachments.length} 个：${msg.attachments.map((a) => a.mime).join(', ')}`, '');
        }
      } else if (msg.role === 'assistant') {
        if (msg.reasoning) {
          lines.push('<details><summary>思考过程</summary>', '', msg.reasoning, '', '</details>', '');
        }
        lines.push('## E-dreikanterbot', '', msg.content || '（空）', '');
      }
    }
    return lines.join('\n');
  }

  async import(payload) {
    const raw = Array.isArray(payload) ? payload : payload?.conversations;
    if (!Array.isArray(raw)) {
      const err = new Error('导入文件需要包含 conversations 数组');
      err.status = 400;
      throw err;
    }
    const created = [];
    for (const item of raw.slice(0, 200)) {
      if (!item || !Array.isArray(item.messages)) continue;
      const doc = await this.create({ title: oneLine(item.title || '导入的对话', 80), model: item.model });
      doc.titleLocked = Boolean(item.titleLocked);
      const clean = item.messages
        .filter((m) => m && ['user', 'assistant', 'system'].includes(m.role))
        .map((m) => ({
          id: newId('m'),
          role: m.role,
          content: typeof m.content === 'string' ? m.content : '',
          reasoning: typeof m.reasoning === 'string' ? m.reasoning : undefined,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
        }));
      doc.messages = clean;
      doc.rootMessageId = clean[0]?.id ?? null;
      clean.forEach((message, index) => {
        message.parentId = clean[index - 1]?.id ?? null;
        message.selectedChildId = clean[index + 1]?.id;
      });
      doc.updatedAt = new Date().toISOString();
      await this._persist(doc);
      created.push(this.meta(doc));
    }
    return created;
  }
}

/* ================================================================== */
/* 长期记忆库                                                          */
/* ================================================================== */

const MAX_FACTS = 5000;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

export function tokenize(text) {
  const value = String(text || '').toLowerCase();
  const tokens = [];
  for (const word of value.match(/[a-z0-9_]{2,}/g) || []) tokens.push(word);
  for (const run of value.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || []) {
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000，。！？、；：""''（）()[\]{}.,!?;:'"]+/g, '');
}

export class MemoryStore {
  constructor({ file, maxChars = 4000 }) {
    this.file = file;
    this.maxChars = maxChars;
    this.facts = [];
    this.docTokens = new Map();
    this.timer = null;
    this.saving = Promise.resolve();
  }

  async init() {
    const data = await readJsonFile(this.file, null);
    if (data && Array.isArray(data.facts)) {
      this.facts = data.facts.filter((f) => f && typeof f.text === 'string' && f.text.trim());
    }
  }

  list({ query = '' } = {}) {
    const q = String(query || '').trim();
    const items = q ? this.search(q, this.facts.length || 1) : [...this.facts];
    return items
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .map((f) => ({ ...f, score: f.score ?? undefined }));
  }

  stats() {
    return {
      count: this.facts.length,
      pinned: this.facts.filter((f) => f.pinned).length,
      chars: this.facts.reduce((sum, f) => sum + f.text.length, 0),
      lastUpdated: this.facts.reduce((max, f) => (f.updatedAt > max ? f.updatedAt : max), ''),
    };
  }

  add({ text, tags = [], source = 'user', pinned = false } = {}) {
    const value = String(text || '').trim();
    if (value.length < 2) {
      const err = new Error('记忆内容太短');
      err.status = 400;
      throw err;
    }
    if (value.length > 2000) {
      const err = new Error('单条记忆不能超过 2000 字');
      err.status = 400;
      throw err;
    }
    const normalized = normalizeText(value);
    const existing = this.facts.find((f) => normalizeText(f.text) === normalized);
    if (existing) {
      return { ...existing, duplicate: true };
    }
    const now = new Date().toISOString();
    const seq = this.facts.reduce((max, f) => Math.max(max, Number(f.seq) || 0), 0) + 1;
    const fact = {
      id: newId('mem'),
      seq,
      text: value,
      tags: (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 8),
      source,
      pinned: Boolean(pinned),
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      lastUsedAt: '',
    };
    this.facts.push(fact);
    if (this.facts.length > MAX_FACTS) {
      const removable = this.facts.findIndex((f) => !f.pinned);
      if (removable >= 0) this.facts.splice(removable, 1);
    }
    this.scheduleSave();
    return fact;
  }

  update(id, patch = {}) {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return null;
    if (typeof patch.text === 'string' && patch.text.trim()) fact.text = patch.text.trim().slice(0, 2000);
    if (patch.tags !== undefined) {
      fact.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags || '').split(/[,，\s]+/))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 8);
    }
    if (patch.pinned !== undefined) fact.pinned = Boolean(patch.pinned);
    fact.updatedAt = new Date().toISOString();
    this.docTokens.delete(fact.id);
    this.scheduleSave();
    return fact;
  }

  remove(id) {
    const idx = this.facts.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    this.facts.splice(idx, 1);
    this.docTokens.delete(id);
    this.scheduleSave();
    return true;
  }

  /** BM25-lite：中文按字 + 双字，英文按词。 */
  search(query, topK = 8) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const docs = this.facts.map((f) => {
      let tokens = this.docTokens.get(f.id);
      if (!tokens) {
        tokens = tokenize(`${f.text} ${(f.tags || []).join(' ')}`);
        this.docTokens.set(f.id, tokens);
      }
      return { fact: f, tokens, tf: countMap(tokens) };
    });
    const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(1, docs.length);
    const df = new Map();
    for (const term of terms) {
      let count = 0;
      for (const doc of docs) if (doc.tf.has(term)) count += 1;
      df.set(term, count);
    }
    const k1 = 1.4;
    const b = 0.75;
    const scored = [];
    for (const doc of docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term) || 0;
        if (!tf) continue;
        const idf = Math.log(1 + (docs.length + 1) / ((df.get(term) || 0) + 0.5));
        const lenNorm = 1 - b + (b * doc.tokens.length) / (avgLen || 1);
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * lenNorm));
      }
      const haystack = `${doc.fact.text} ${(doc.fact.tags || []).join(' ')}`.toLowerCase();
      if (terms.some((t) => t.length >= 2 && haystack.includes(t))) score += 0.8;
      if (doc.fact.pinned) score += 0.4;
      if (score > 0) scored.push({ ...doc.fact, score: Math.round(score * 1000) / 1000 });
    }
    return scored.sort((a, b2) => b2.score - a.score || String(b2.updatedAt).localeCompare(String(a.updatedAt))).slice(0, Math.max(1, topK));
  }

  /**
   * 生成注入用的记忆块。选中的条目按 createdAt 升序拼接，
   * 保证前缀稳定，最大化 DeepSeek 上下文缓存命中。
   */
  buildBlock({ query = '', topK = 8, maxChars = this.maxChars } = {}) {
    let chosen;
    if (query) {
      chosen = this.search(query, topK);
      if (chosen.length < topK) {
        const pinned = this.facts.filter((f) => f.pinned && !chosen.some((c) => c.id === f.id));
        chosen = chosen.concat(pinned.slice(0, topK - chosen.length));
      }
    } else {
      chosen = [...this.facts].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, topK);
    }

    const sorted = chosen
      .slice()
      .sort(
        (a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)) ||
          (Number(a.seq) || 0) - (Number(b.seq) || 0) ||
          String(a.id).localeCompare(String(b.id)),
      );

    const header = `<memory>\n以下是长期记忆库中与当前对话相关的用户信息（按写入时间排序，仅供参考，若与用户当前说法冲突以当前为准）：`;
    const footer = '\n</memory>';
    const lines = [];
    let used = header.length + footer.length;
    for (const fact of sorted) {
      const date = String(fact.createdAt || '').slice(0, 10);
      const tag = fact.tags?.length ? `（标签：${fact.tags.join('、')}）` : '';
      const singleLine = String(fact.text).replace(/\s+/g, ' ').trim();
      const line = `- [${date}] ${singleLine}${tag}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (!lines.length) return { text: '', facts: [] };

    for (const fact of sorted) {
      if (lines.some((line) => line.includes(String(fact.text).replace(/\s+/g, ' ').trim()))) {
        fact.useCount = (Number(fact.useCount) || 0) + 1;
        fact.lastUsedAt = new Date().toISOString();
      }
    }
    this.scheduleSave();

    return { text: `${header}\n${lines.join('\n')}${footer}`, facts: sorted.filter((f) => lines.some((l) => l.includes(f.text))) };
  }

  /** 供模型工具 recall_memory 使用；保持稳定排序。 */
  recall(query, topK = 6) {
    return this.search(query, topK).map((f) => ({
      id: f.id,
      text: f.text,
      tags: f.tags,
      createdAt: f.createdAt,
      score: f.score,
    }));
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(() => {});
    }, 250);
    this.timer.unref?.();
  }

  save() {
    this.saving = this.saving
      .catch(() => {})
      .then(() => atomicWrite(this.file, JSON.stringify({ version: 1, facts: this.facts }, null, 2)));
    return this.saving;
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
    await this.saving.catch(() => {});
  }
}

function countMap(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
  return map;
}

export function memoryFactPreview(fact) {
  return `${oneLine(fact.text, 100)}${fact.tags?.length ? ` · ${fact.tags.join('/')}` : ''}`;
}

export function isCjk(text) {
  return CJK_RE.test(String(text || ''));
}

export function attachmentExt(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] || 'bin';
}

export function attachmentName(id, mime) {
  return safeFilename(`${id}.${attachmentExt(mime)}`);
}
