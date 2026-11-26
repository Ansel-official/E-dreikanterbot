import { escapeHtml, renderMarkdown } from './markdown.js?v=4';

/* ==========================================================================
   基础工具
   ========================================================================== */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORAGE = {
  settings: 'edb.settings.v1',
  theme: 'edb.theme',
  client: 'edb.client',
  lastConv: 'edb.lastConversation',
};

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

function uid(prefix = 'm') {
  const rand = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}_${rand.replace(/-/g, '').slice(0, 18)}`;
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function formatCost(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.000001) return '<$0.000001';
  return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, (Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${Math.round(seconds - m * 60)}s`;
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(date, today)) return '今天';
  if (sameDay(date, yesterday)) return '昨天';
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/* ==========================================================================
   状态
   ========================================================================== */
const state = {
  config: null,
  conversations: [],
  current: null,
  messages: [],
  memory: [],
  memoryStats: { count: 0 },
  settings: {},
  theme: localStorage.getItem(STORAGE.theme) || 'auto',
  filter: '',
  memoryFilter: '',
  draftImages: [],
  streaming: false,
  abort: null,
  lastUsage: null,
  drawer: null,
  sendSeq: 0,
  installPrompt: null,
  clientId: (() => {
    let id = localStorage.getItem(STORAGE.client);
    if (!id) {
      const rand = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
      id = `web_${rand.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`;
      localStorage.setItem(STORAGE.client, id);
    }
    return id;
  })(),
};

/* ==========================================================================
   API
   ========================================================================== */
class ApiError extends Error {
  constructor(message, { status = 0, code = '', hint = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['x-requested-with'] = 'E-dreikanterbot';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    if (state.config?.features?.login) showLogin();
    throw new ApiError(data?.error?.message || '需要登录', { status: 401 });
  }
  if (!res.ok) {
    throw new ApiError(data?.error?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: data?.error?.code,
      hint: data?.error?.hint,
    });
  }
  return data;
}

/* ==========================================================================
   Toast / 模态
   ========================================================================== */
function toast(message, type = '') {
  const host = $('#toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'spark')}<span></span>`;
  $('span', node).textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'all .2s ease';
    setTimeout(() => node.remove(), 220);
  }, 3200);
}

function modal({ title, body, confirmText = '确定', cancelText = '取消', danger = false, onConfirm }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title"></h3>
        <div class="modal-body"></div>
        <div class="modal-actions">
          ${cancelText ? `<button class="btn ghost" data-modal="cancel"></button>` : ''}
          <button class="btn ${danger ? 'danger' : 'accent'}" data-modal="ok"></button>
        </div>
      </div>`;
    $('#modal-title', overlay).textContent = title;
    const bodyEl = $('.modal-body', overlay);
    if (body instanceof Node) bodyEl.appendChild(body);
    else bodyEl.innerHTML = body || '';

    const okBtn = $('[data-modal="ok"]', overlay);
    okBtn.textContent = confirmText;
    const cancelBtn = $('[data-modal="cancel"]', overlay);
    if (cancelBtn) cancelBtn.textContent = cancelText;

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter' && !event.isComposing) {
        if (document.activeElement?.tagName !== 'TEXTAREA') close(true);
      }
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
      const action = event.target.closest('[data-modal]')?.dataset.modal;
      if (action === 'cancel') close(false);
      if (action === 'ok') {
        if (onConfirm) onConfirm();
        close(true);
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => okBtn.focus(), 30);
  });
}

function confirmDelete(title, message) {
  return modal({ title, body: `<p class="modal-text">${escapeHtml(message)}</p>`, confirmText: '删除', danger: true });
}

/* ==========================================================================
   主题
   ========================================================================== */
function applyTheme() {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const resolved = state.theme === 'auto' ? (prefersDark ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.theme = resolved;
  const btn = $('#theme-btn');
  if (btn) btn.innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f1117' : '#f7f7f5');
}

function cycleTheme() {
  state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
  localStorage.setItem(STORAGE.theme, state.theme);
  applyTheme();
  toast(`主题：${state.theme === 'auto' ? '跟随系统' : state.theme === 'light' ? '浅色' : '深色'}`);
}

/* ==========================================================================
   设置
   ========================================================================== */
function loadSavedSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.settings) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function defaultsFromConfig() {
  const config = state.config || {};
  const defaults = config.defaults || {};
  return {
    model: config.defaultModel || 'deepseek-flash',
    thinking: defaults.thinking !== false,
    reasoning_effort: defaults.reasoningEffort || 'high',
    max_tokens: defaults.maxTokens || 65536,
    temperature: defaults.temperature ?? 1,
    top_p: defaults.topP ?? 0.95,
    stop: [],
    json_mode: false,
    web_search: Boolean(defaults.webTools),
    read_url: Boolean(defaults.webTools),
    memory: defaults.memory !== false,
    title: defaults.title !== false,
    safety: defaults.safetyLevel === 'low' ? 'low' : 'high',
  };
}

function mergeDefaults() {
  state.settings = { ...defaultsFromConfig(), ...loadSavedSettings() };
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(state.settings.model)) {
    state.settings.model = state.config.defaultModel;
  }
  if (!['low', 'high', 'max'].includes(state.settings.reasoning_effort)) {
    state.settings.reasoning_effort = 'high';
  }
  state.settings.max_tokens = Math.min(393216, Math.max(1, Number(state.settings.max_tokens) || 65536));
  state.settings.stop = Array.isArray(state.settings.stop) ? state.settings.stop.slice(0, 16) : [];
}

function saveSettings() {
  localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings));
}

function updateSetting(patch) {
  Object.assign(state.settings, patch);
  saveSettings();
  syncSettingsUI();
  renderComposerState();
}

function settingsPayload() {
  return {
    model: state.settings.model,
    thinking: Boolean(state.settings.thinking),
    reasoning_effort: state.settings.thinking ? state.settings.reasoning_effort : 'none',
    max_tokens: Math.min(393216, Math.max(1, Math.round(Number(state.settings.max_tokens) || 65536))),
    temperature: Number(state.settings.temperature),
    top_p: Number(state.settings.top_p),
    stop: state.settings.stop,
    json_mode: Boolean(state.settings.json_mode),
    web_search: Boolean(state.settings.web_search),
    read_url: Boolean(state.settings.read_url),
    memory: Boolean(state.settings.memory),
    title: Boolean(state.settings.title),
    safety_check: state.settings.safety,
    user_id: state.clientId,
  };
}

function parseStop(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function syncSettingsUI() {
  if (!state.settings.model) return;
  const s = state.settings;

  $$('#model-cards input').forEach((input) => {
    input.checked = input.value === s.model;
  });

  $$('#effort-seg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.effort === s.reasoning_effort);
    button.disabled = !s.thinking;
  });

  if ($('#max-tokens')) $('#max-tokens').value = String(s.max_tokens);
  $$('#token-presets button').forEach((button) => {
    button.classList.toggle('accent', Number(button.dataset.tokens) === Number(s.max_tokens));
  });

  if ($('#temperature')) {
    $('#temperature').value = String(s.temperature);
    $('#temperature-value').textContent = Number(s.temperature).toFixed(2);
    $('#temperature').disabled = Boolean(s.thinking);
  }
  if ($('#top-p')) {
    $('#top-p').value = String(s.top_p);
    $('#top-p-value').textContent = Number(s.top_p).toFixed(2);
    $('#top-p').disabled = Boolean(s.thinking);
  }
  if ($('#stop-sequences') && document.activeElement !== $('#stop-sequences')) {
    $('#stop-sequences').value = (s.stop || []).join('\n');
  }

  setSwitch('#thinking-switch', s.thinking);
  setSwitch('#json-switch', s.json_mode);
  setSwitch('#web-search-switch', s.web_search);
  setSwitch('#read-url-switch', s.read_url);
  setSwitch('#memory-switch', s.memory);
  setSwitch('#title-switch', s.title);

  $$('#safety-seg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.safety === s.safety);
  });

  $('#model-chip').textContent = s.model === 'deepseek-v4-pro' ? 'pro' : 'flash';
  renderRequestPreview();
}

function setSwitch(selector, value) {
  $(selector)?.setAttribute('aria-checked', String(Boolean(value)));
}

function renderRequestPreview() {
  const pre = $('#request-preview');
  if (!pre || !state.settings.model) return;
  const s = state.settings;
  const payload = {
    model: s.model,
    messages: [
      { role: 'system', content: '（人设 + 记忆库 Top-K + 日期，由服务端拼装）' },
      { role: 'user', content: '（你的消息）' },
    ],
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: s.thinking ? 'enabled' : 'disabled' },
    reasoning_effort: s.thinking ? s.reasoning_effort : undefined,
    max_tokens: Number(s.max_tokens),
    temperature: s.thinking ? undefined : Number(s.temperature),
    top_p: s.thinking ? undefined : Number(s.top_p),
    user_id: state.clientId,
  };
  if (!s.thinking) {
    delete payload.reasoning_effort;
  } else {
    delete payload.temperature;
    delete payload.top_p;
  }
  if (s.stop?.length) payload.stop = s.stop;
  if (s.json_mode) payload.response_format = { type: 'json_object' };
  if (s.safety === 'high') payload.safety_check = { level: 'high' };
  if (s.title) payload.title = { enabled: true };
  const tools = [];
  if (s.memory) tools.push('remember_fact', 'recall_memory');
  if (s.web_search) tools.push('deepseek_web_search');
  if (s.read_url) tools.push('deepseek_read_url');
  if (tools.length) payload.tools = tools.map((name) => `…${name}`);

  pre.textContent = JSON.stringify(payload, null, 2);
}

function resetSettings() {
  localStorage.removeItem(STORAGE.settings);
  state.settings = defaultsFromConfig();
  saveSettings();
  syncSettingsUI();
  renderComposerState();
  toast('已恢复默认参数', 'ok');
}

function maxSettings() {
  Object.assign(state.settings, {
    model: 'deepseek-v4-pro',
    thinking: true,
    reasoning_effort: 'max',
    max_tokens: 393216,
    temperature: 1,
    top_p: 1,
    json_mode: false,
    web_search: true,
    read_url: true,
    memory: true,
    title: true,
    safety: 'high',
  });
  saveSettings();
  syncSettingsUI();
  renderComposerState();
  toast('已拉满：v4-pro · max effort · 384K 输出 · 联网 · 记忆');
}

/* ==========================================================================
   渲染：配置 / 侧栏
   ========================================================================== */
function renderConfigBits() {
  const config = state.config;
  if (!config) return;
  const site = config.site || {};

  if ($('#site-name')) $('#site-name').textContent = site.name || 'E-dreikanterbot';
  if ($('#foot-version')) $('#foot-version').textContent = `v${config.version || '1.0.0'}`;
  if ($('#chat-title') && !state.current) $('#chat-title').textContent = '新对话';

  const icp = site.icpNumber;
  const icpLink = site.icpLink || 'https://beian.miit.gov.cn/';
  for (const selector of ['#icp-foot', '#icp-link']) {
    const el = $(selector);
    if (!el) continue;
    el.textContent = icp || 'ICP 备案待配置';
    el.href = icpLink;
    el.title = icp ? `ICP 备案号：${icp}` : '部署到公网前需完成 ICP 备案，见 docs/ICP.md';
  }

  const police = site.policeNumber;
  const policeEl = $('#police-foot');
  const policeSep = $('#police-sep');
  if (policeEl) {
    policeEl.hidden = !police;
    if (police) {
      policeEl.textContent = police;
      policeEl.href = site.policeLink || 'https://beian.mps.gov.cn/';
    }
  }
  if (policeSep) policeSep.hidden = !police;

  const notice = $('#setup-notice');
  if (notice) {
    const missing = !config.features?.keyConfigured;
    notice.hidden = !missing;
    if (missing) {
      notice.innerHTML =
        `${icon('key')}<div><strong>还没有配置 DeepSeek API Key</strong><br />` +
        `在项目根目录执行 <code>cp .env.example .env</code>，填入 <code>DEEPSEEK_API_KEY</code> 后重启服务即可对话。` +
        `<br /><a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">申请 API Key</a></div>`;
    }
  }

  const logout = $('#logout-item');
  if (logout) logout.hidden = !config.features?.login;
  if ($('#install-item')) $('#install-item').hidden = !state.installPrompt;

  const memoryCount = $('#memory-count');
  if (memoryCount) memoryCount.textContent = String(state.memoryStats.count || 0);
}

function renderConversations() {
  const host = $('#conv-list');
  if (!host) return;
  const keyword = state.filter.trim().toLowerCase();
  const items = state.conversations.filter((item) => {
    if (!keyword) return true;
    return `${item.title} ${item.preview || ''}`.toLowerCase().includes(keyword);
  });

  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = `<div class="conv-empty">${keyword ? '没有匹配的对话' : '还没有对话，发第一条消息吧'}</div>`;
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const label = dayLabel(item.updatedAt || item.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }

  for (const [label, list] of groups) {
    const group = document.createElement('div');
    group.className = 'conv-group';
    const heading = document.createElement('div');
    heading.className = 'conv-group-label';
    heading.textContent = label;
    group.appendChild(heading);

    for (const item of list) {
      const row = document.createElement('div');
      row.className = `conv-item${state.current?.id === item.id ? ' active' : ''}`;
      row.dataset.id = item.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.innerHTML = `
        <div class="conv-item-main">
          <div class="conv-title"></div>
          <div class="conv-preview"></div>
        </div>
        <button class="conv-del" data-del="${item.id}" aria-label="删除对话" title="删除">${icon('trash')}</button>`;
      $('.conv-title', row).textContent = item.title || '新对话';
      $('.conv-preview', row).textContent = item.preview || `${item.messageCount || 0} 条消息`;
      group.appendChild(row);
    }
    host.appendChild(group);
  }
}

/* ==========================================================================
   渲染：消息
   ========================================================================== */
function visibleMessages(messages) {
  return (messages || [])
    .filter((msg) => !msg.hidden && (msg.role === 'user' || msg.role === 'assistant'))
    .map((msg) => ({ ...msg }));
}

function renderMessages() {
  const host = $('#messages');
  if (!host) return;
  const nearBottom = isNearBottom();
  host.innerHTML = '';

  if (!state.messages.length) {
    host.appendChild(emptyState());
    host.scrollTop = 0;
    if ($('#scroll-bottom')) $('#scroll-bottom').hidden = true;
    return;
  }

  const lastAssistant = [...state.messages].reverse().find((msg) => msg.role === 'assistant');
  const frag = document.createDocumentFragment();
  for (const msg of state.messages) {
    const el = messageEl(msg, { isLastAssistant: lastAssistant && lastAssistant.id === msg.id });
    if (el) frag.appendChild(el);
  }
  host.appendChild(frag);

  if (state.streaming || nearBottom || state.stickToBottom) {
    requestAnimationFrame(() => scrollToBottom(true));
  }
}

function emptyState() {
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const suggestions = [
    { icon: 'spark', title: '解释一个概念', text: '把量子纠缠讲给高中生听，用一个生活化比喻', prompt: '把量子纠缠讲给高中生听，用一个生活化比喻。' },
    { icon: 'edit', title: '写一段代码', text: 'TypeScript 写带重试与超时的 fetch 封装', prompt: '用 TypeScript 写一个带重试与超时控制的 fetch 封装，并解释设计取舍。' },
    { icon: 'link', title: '读一个链接', text: '总结 DeepSeek 官方文档要点', prompt: '请总结 https://api-docs.deepseek.com/ 的核心能力，并列出三个上手建议。' },
    { icon: 'brain', title: '用记忆库', text: '记住我的偏好，之后自动适配', prompt: '请记住：我偏好中文回答，代码示例用 TypeScript，先给结论再解释。' },
  ];
  const wrapper = document.createElement('div');
  wrapper.className = 'empty';
  wrapper.innerHTML = `
    <div class="empty-orb" aria-hidden="true">E</div>
    <h1>${greeting}，今天想聊点什么？</h1>
    <p class="lead">直连 DeepSeek 官方 API 的聊天机器人：深度思考、长期记忆、图片理解与联网搜索，都在这里。</p>
    <div class="suggestions">
      ${suggestions
        .map(
          (item) =>
            `<button class="suggestion" data-prompt="${escapeHtml(item.prompt)}">${icon(item.icon)}` +
            `<span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></span></button>`,
        )
        .join('')}
    </div>
    <div class="empty-actions">
      <button class="btn accent" data-action="max-settings">${icon('spark')} 参数拉满试试</button>
      <button class="btn ghost" data-action="open-memory">${icon('brain')} 查看记忆库</button>
    </div>
    <div class="badge-row"><span>1M 上下文</span><span>384K 输出</span><span>流式思考</span><span>OpenAI 兼容接口</span></div>`;
  return wrapper;
}

function messageEl(msg, { isLastAssistant = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;
  wrap.dataset.msgId = msg.id;

  if (msg.role === 'user') {
    wrap.innerHTML = `
      <div class="msg-body">
        <div class="msg-head"><span class="msg-name">你</span><span class="msg-time">${formatTime(msg.createdAt)}</span>
          <span class="msg-actions">
            <button data-action="copy-message" data-id="${escapeHtml(msg.id)}" title="复制">${icon('copy')}</button>
            <button data-action="save-memory" data-id="${escapeHtml(msg.id)}" title="存入记忆库">${icon('brain')}</button>
          </span>
        </div>
        <div class="user-images" hidden></div>
        <div class="user-bubble"></div>
      </div>
      <div class="avatar">我</div>`;
    $('.user-bubble', wrap).textContent = msg.content || '';
    const imagesHost = $('.user-images', wrap);
    const attachments = msg.attachments || [];
    if (attachments.length) {
      imagesHost.hidden = false;
      for (const attachment of attachments) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '用户上传的图片';
        img.src = attachment.preview || (attachment.file ? `/api/files/${encodeURIComponent(attachment.file)}` : '');
        if (img.src) imagesHost.appendChild(img);
      }
    }
    return wrap;
  }

  wrap.innerHTML = `
    <div class="avatar">E<span></span></div>
    <div class="msg-body">
      <div class="msg-head">
        <span class="msg-name">E-dreikanterbot</span>
        <span class="msg-time">${formatTime(msg.createdAt)}</span>
        <span class="msg-actions">
          <button data-action="copy-message" data-id="${escapeHtml(msg.id)}" title="复制回答">${icon('copy')}</button>
          <button data-action="save-memory" data-id="${escapeHtml(msg.id)}" title="存入记忆库">${icon('brain')}</button>
          ${isLastAssistant && !msg.streaming ? `<button data-action="regenerate" data-id="${escapeHtml(msg.id)}" title="重新生成">${icon('refresh')}</button>` : ''}
        </span>
      </div>
      <div class="thinking-slot"></div>
      <div class="tool-slot"></div>
      <div class="error-slot"></div>
      <div class="md${msg.streaming ? ' streaming' : ''}"></div>
      <div class="msg-foot"></div>
    </div>`;

  const md = $('.md', wrap);
  if (msg.content) md.innerHTML = renderMarkdown(msg.content);
  else if (msg.streaming) md.innerHTML = '<p class="muted">…</p>';

  if (msg.reasoning) {
    $('.thinking-slot', wrap).appendChild(thinkingEl(msg));
  }

  if (msg.tools?.length) {
    $('.tool-slot', wrap).innerHTML = `<div class="tool-chips">${msg.tools
      .map(
        (tool) =>
          `<span class="tool-chip${tool.status === 'error' ? ' error' : ''}" title="${escapeHtml(tool.name || '')}">` +
          `${icon(tool.status === 'error' ? 'alert' : 'check')}<span>${escapeHtml(tool.summary || tool.name || '工具调用')}</span></span>`,
      )
      .join('')}</div>`;
  }

  if (msg.error) {
    const error = $('.error-slot', wrap);
    error.innerHTML = `<div class="msg-error"><strong>${escapeHtml(msg.error.message || '请求失败')}</strong>${
      msg.error.hint ? `<div class="hint">${escapeHtml(msg.error.hint)}</div>` : ''
    }</div>`;
  }

  const foot = $('.msg-foot', wrap);
  if (msg.streaming) {
    foot.innerHTML = `<span class="live-dot">正在生成…</span>`;
  } else {
    foot.innerHTML = footHtml(msg);
  }
  return wrap;
}

function thinkingEl(msg) {
  const details = document.createElement('details');
  details.className = `thinking${msg.streaming ? ' live' : ''}`;
  details.open = Boolean(msg.streaming);
  const summary = document.createElement('summary');
  summary.innerHTML = `<span class="dot"></span><span class="label"></span>`;
  $('.label', summary).textContent = thinkingLabel(msg);
  const body = document.createElement('div');
  body.className = 'thinking-body';
  body.textContent = msg.reasoning || '';
  details.append(summary, body);
  return details;
}

function thinkingLabel(msg) {
  const chars = String(msg.reasoning || '').length;
  if (msg.streaming) return chars ? `正在深度思考… ${chars} 字` : '正在深度思考…';
  return chars ? `已深度思考 · ${chars} 字` : '思考过程';
}

function footHtml(msg) {
  const parts = [];
  const usage = msg.usage;
  if (usage) {
    parts.push(`↑ ${formatTokens(usage.prompt_tokens)}`);
    parts.push(`↓ ${formatTokens(usage.completion_tokens)}`);
    const cached = Number(usage.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
    if (usage.prompt_tokens) parts.push(`缓存 ${Math.round((cached / usage.prompt_tokens) * 100)}%`);
    if (usage.cost) parts.push(formatCost(usage.cost));
  }
  if (msg.aborted) parts.push('已停止');
  if (!parts.length) return '';
  return parts.map((part) => `<span>${escapeHtml(part)}</span>`).join('<span class="sep"></span>');
}

/* ==========================================================================
   流式更新（只改当前消息，避免整页重绘）
   ========================================================================== */
let streamTimer = null;

function scheduleStreamUpdate() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    updateStreamingDom();
  }, 55);
}

function updateStreamingDom() {
  const msg = state.messages.find((item) => item.streaming);
  if (!msg) return;
  const el = document.querySelector(`.msg[data-msg-id="${msg.id}"]`);
  if (!el) return;

  const md = $('.md', el);
  if (md) {
    md.innerHTML = msg.content ? renderMarkdown(msg.content) : '<p class="muted">…</p>';
    md.classList.add('streaming');
  }

  if (msg.reasoning) {
    let thinking = $('.thinking', el);
    if (!thinking) {
      $('.thinking-slot', el).appendChild(thinkingEl(msg));
      thinking = $('.thinking', el);
    }
    const label = $('.label', thinking);
    if (label) label.textContent = thinkingLabel(msg);
    const body = $('.thinking-body', thinking);
    if (body) body.textContent = msg.reasoning;
    thinking.classList.add('live');
  }

  if (msg.tools?.length) {
    $('.tool-slot', el).innerHTML = `<div class="tool-chips">${msg.tools
      .map(
        (tool) =>
          `<span class="tool-chip${tool.status === 'error' ? ' error' : ''}">` +
          `${icon(tool.status === 'error' ? 'alert' : 'check')}<span>${escapeHtml(tool.summary || tool.name || '')}</span></span>`,
      )
      .join('')}</div>`;
  }

  if (msg.error) {
    $('.error-slot', el).innerHTML = `<div class="msg-error"><strong>${escapeHtml(
      msg.error.message || '请求失败',
    )}</strong>${msg.error.hint ? `<div class="hint">${escapeHtml(msg.error.hint)}</div>` : ''}</div>`;
  }

  if (state.stickToBottom) scrollToBottom(true);
}

/* ==========================================================================
   滚动
   ========================================================================== */
function isNearBottom() {
  const host = $('#messages');
  if (!host) return true;
  return host.scrollHeight - host.scrollTop - host.clientHeight < 140;
}

function scrollToBottom(force = false) {
  const host = $('#messages');
  if (!host) return;
  if (force || state.stickToBottom) host.scrollTop = host.scrollHeight;
}

/* ==========================================================================
   用量
   ========================================================================== */
function renderUsage() {
  const bar = $('#usage-bar');
  if (!bar) return;
  const usage = state.lastUsage;
  if (!usage) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const hit = Number(usage.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
  const prompt = Number(usage.prompt_tokens) || 0;
  const cachePct = prompt ? Math.round((hit / prompt) * 100) : 0;
  const pieces = [`↑ ${formatTokens(prompt)}`, `↓ ${formatTokens(usage.completion_tokens)}`, `缓存 ${cachePct}%`];
  if (usage.cost) pieces.push(formatCost(usage.cost));
  if (usage.elapsedMs) pieces.push(formatDuration(usage.elapsedMs));
  $('#usage-text').textContent = pieces.join(' · ');

  const tier = usage.costDetail?.tier || state.config?.pricing?.tier || '';
  const tierEl = $('#usage-tier');
  tierEl.textContent = tier === 'peak' ? '高峰计价' : tier ? '低峰计价' : '';
  tierEl.className = `usage-tier ${tier === 'peak' ? 'peak' : ''}`;
  tierEl.title = '按官方 UTC 高峰时段估算，未扣除法定节假日';
}

/* ==========================================================================
   输入框
   ========================================================================== */
function autosize() {
  const el = $('#composer');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
}

function renderComposerState() {
  const btn = $('#send-btn');
  if (!btn) return;
  if (state.streaming) {
    btn.classList.add('stop');
    btn.innerHTML = icon('stop');
    btn.title = '停止生成';
    btn.setAttribute('aria-label', '停止生成');
  } else {
    btn.classList.remove('stop');
    btn.innerHTML = icon('send');
    btn.title = '发送';
    btn.setAttribute('aria-label', '发送');
  }
  $('#thinking-toggle')?.classList.toggle('on', Boolean(state.settings.thinking));
  $('#web-toggle')?.classList.toggle('on', Boolean(state.settings.web_search));
  $('#thinking-toggle')?.setAttribute('aria-pressed', String(Boolean(state.settings.thinking)));
  $('#web-toggle')?.setAttribute('aria-pressed', String(Boolean(state.settings.web_search)));
}

function renderAttachments() {
  const host = $('#attachments');
  if (!host) return;
  host.hidden = !state.draftImages.length;
  host.innerHTML = '';
  for (const image of state.draftImages) {
    const item = document.createElement('div');
    item.className = 'attachment';
    item.innerHTML = `<img alt="待发送图片" src="${image.dataUrl}" /><button type="button" data-action="remove-image" data-img="${image.id}" aria-label="移除">${icon('x')}</button>`;
    host.appendChild(item);
  }
}

async function addImageFiles(files) {
  const list = [...files].filter((file) => file && file.type?.startsWith('image/'));
  if (!list.length) return;
  for (const file of list) {
    if (state.draftImages.length >= 4) {
      toast('最多同时发送 4 张图片', 'error');
      break;
    }
    try {
      const dataUrl = await prepareImage(file);
      state.draftImages.push({ id: uid('img'), dataUrl });
    } catch (err) {
      toast(err.message || '图片处理失败', 'error');
    }
  }
  renderAttachments();
}

function prepareImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      return reject(new Error('仅支持 JPG / PNG / WebP / GIF'));
    }
    if (file.size > 8 * 1024 * 1024) {
      return reject(new Error('单张图片不能超过 8MB'));
    }
    if (file.type === 'image/gif' || file.size < 380 * 1024) {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

/* ==========================================================================
   SSE 客户端
   ========================================================================== */
async function streamChat(payload, signal, handlers) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'E-dreikanterbot' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: data?.error?.code,
      hint: data?.error?.hint,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (!dataLines.length) continue;
        let data;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }
        handlers[event]?.(data);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/* ==========================================================================
   发送 / 停止 / 重新生成
   ========================================================================== */
async function sendMessage({ text = null, regenerate = false } = {}) {
  if (state.streaming) {
    toast('正在生成，请先停止');
    return;
  }
  if (!state.config?.features?.keyConfigured) {
    toast('服务端未配置 DEEPSEEK_API_KEY', 'error');
    return;
  }

  const content = (text ?? $('#composer').value).trim();
  const images = regenerate ? [] : state.draftImages.map((image) => image.dataUrl);
  if (!regenerate && !content && !images.length) return;
  if (content.length > 100_000) {
    toast('单条消息不能超过 10 万字符', 'error');
    return;
  }

  if (!regenerate) {
    state.messages.push({
      id: uid('local'),
      role: 'user',
      content,
      attachments: images.map((dataUrl) => ({ preview: dataUrl })),
      createdAt: new Date().toISOString(),
    });
  } else {
    while (state.messages.length && state.messages.at(-1).role === 'assistant') state.messages.pop();
  }

  if (!state.current) state.current = { id: null, title: '', messages: [] };
  if (!state.current.title || state.current.title === '新对话') {
    state.current.title = content ? content.slice(0, 24) : '图片对话';
  }
  if ($('#chat-title')) $('#chat-title').textContent = state.current.title;

  const assistant = {
    id: uid('stream'),
    role: 'assistant',
    content: '',
    reasoning: '',
    tools: [],
    streaming: true,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(assistant);

  const seq = ++state.sendSeq;
  state.streaming = true;
  state.abort = new AbortController();
  state.stickToBottom = true;

  $('#composer').value = '';
  state.draftImages = [];
  renderAttachments();
  autosize();
  renderMessages();
  renderComposerState();

  const startedAt = Date.now();
  let conversationId = state.current.id;
  let gotMeta = false;

  const tick = setInterval(() => {
    if (seq !== state.sendSeq) return;
    const foot = document.querySelector(`.msg[data-msg-id="${assistant.id}"] .msg-foot`);
    if (foot) foot.innerHTML = `<span class="live-dot">正在生成… ${((Date.now() - startedAt) / 1000).toFixed(1)}s</span>`;
  }, 500);

  const guarded = (fn) => (data) => {
    if (seq === state.sendSeq) fn(data);
  };

  try {
    await streamChat(
      {
        conversationId,
        message: content,
        images,
        regenerate,
        clientId: state.clientId,
        settings: settingsPayload(),
      },
      state.abort.signal,
      {
        meta: guarded((data) => {
          gotMeta = true;
          conversationId = data.conversationId;
          state.current.id = data.conversationId;
          localStorage.setItem(STORAGE.lastConv, data.conversationId);
          if (!state.current.title) state.current.title = content ? content.slice(0, 24) : '图片对话';
        }),
        reasoning: guarded((data) => {
          assistant.reasoning += data.delta || '';
          scheduleStreamUpdate();
        }),
        content: guarded((data) => {
          assistant.content += data.delta || '';
          scheduleStreamUpdate();
        }),
        tool: guarded((data) => {
          assistant.tools.push(data);
          scheduleStreamUpdate();
          if (data.name === 'remember_fact') loadMemory().catch(() => {});
        }),
        title: guarded((data) => {
          if (state.current) {
            state.current.title = data.title;
            if ($('#chat-title')) $('#chat-title').textContent = data.title;
          }
        }),
        notice: guarded((data) => toast(data.message)),
        usage: guarded((data) => {
          assistant.usage = data;
          state.lastUsage = data;
          renderUsage();
        }),
        error: guarded((data) => {
          assistant.error = { message: data.message, hint: data.hint, status: data.status };
          scheduleStreamUpdate();
        }),
        done: guarded((data) => {
          assistant.aborted = Boolean(data.aborted);
          if (data.messageId) assistant.id = data.messageId;
        }),
      },
    );
  } catch (err) {
    if (seq === state.sendSeq) {
      if (err.name === 'AbortError') {
        assistant.aborted = true;
        if (!assistant.content && !assistant.reasoning) {
          state.messages = state.messages.filter((item) => item !== assistant);
        }
        toast('已停止生成');
      } else {
        assistant.error = assistant.error || { message: err.message, hint: err.hint, status: err.status };
      }
    }
  } finally {
    clearInterval(tick);
    if (seq === state.sendSeq) {
      assistant.streaming = false;
      state.streaming = false;
      state.abort = null;
      renderMessages();
      renderComposerState();
      renderUsage();
      loadConversations().catch(() => {});
      if (!gotMeta) {
        if (state.current && !state.current.id) state.current = null;
      }
    }
  }
}

function stopStreaming() {
  state.abort?.abort();
}

/* ==========================================================================
   会话
   ========================================================================== */
async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.data || [];
  renderConversations();
}

async function openConversation(id, silent = false) {
  const data = await api(`/api/conversations/${id}`);
  const doc = data.data;
  state.current = doc;
  state.messages = visibleMessages(doc.messages);
  state.lastUsage = [...state.messages].reverse().find((msg) => msg.usage)?.usage || null;
  localStorage.setItem(STORAGE.lastConv, id);
  if ($('#chat-title')) $('#chat-title').textContent = doc.title || '新对话';
  renderMessages();
  renderUsage();
  renderConversations();
  if (!silent) closeAllPanels();
  scrollToBottom(true);
}

function newChat() {
  if (state.streaming) {
    state.sendSeq += 1;
    state.abort?.abort();
    state.streaming = false;
    state.abort = null;
  }
  state.current = null;
  state.messages = [];
  state.lastUsage = null;
  state.draftImages = [];
  localStorage.removeItem(STORAGE.lastConv);
  $('#chat-title').textContent = '新对话';
  $('#composer').value = '';
  renderAttachments();
  renderMessages();
  renderUsage();
  renderConversations();
  renderComposerState();
  closeAllPanels();
  autosize();
  const list = $('#messages');
  if (list) list.scrollTop = 0;
  $('#composer').focus();
}

async function deleteConversation(id) {
  const confirmed = await confirmDelete('删除这个对话？', '对话与其中的图片将从服务器删除，无法恢复。');
  if (!confirmed) return;
  await api(`/api/conversations/${id}`, { method: 'DELETE' });
  if (state.current?.id === id) {
    state.current = null;
    state.messages = [];
    state.lastUsage = null;
    renderMessages();
    renderUsage();
  }
  await loadConversations();
  toast('对话已删除', 'ok');
}

async function exportConversation(format) {
  if (!state.current?.id) {
    toast('当前没有可导出的对话', 'error');
    return;
  }
  const link = document.createElement('a');
  link.href = `/api/conversations/${state.current.id}/export?format=${format}`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast(`正在导出 ${format.toUpperCase()}`);
}

async function importConversations(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    toast('文件不是合法 JSON', 'error');
    return;
  }
  const result = await api('/api/conversations/import', { method: 'POST', body: payload });
  await loadConversations();
  toast(`已导入 ${result.count} 个对话`, 'ok');
  if (result.data?.[0]) await openConversation(result.data[0].id);
}

/* ==========================================================================
   记忆库
   ========================================================================== */
async function loadMemory() {
  const data = await api('/api/memory');
  state.memory = data.data || [];
  state.memoryStats = data.stats || { count: state.memory.length };
  renderMemory();
  if ($('#memory-count')) $('#memory-count').textContent = String(state.memoryStats.count || 0);
}

function renderMemory() {
  const host = $('#memory-list');
  if (!host) return;
  const keyword = state.memoryFilter.trim().toLowerCase();
  const items = state.memory.filter((fact) => {
    if (!keyword) return true;
    return `${fact.text} ${(fact.tags || []).join(' ')}`.toLowerCase().includes(keyword);
  });

  if ($('#memory-stats')) {
    $('#memory-stats').textContent = `${state.memoryStats.count || 0} 条记忆 · ${state.memoryStats.pinned || 0} 条置顶`;
  }

  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = `<div class="memory-empty">${
      keyword ? '没有匹配的记忆' : '记忆库还是空的。添加一条，或在对话里让模型记住。'
    }</div>`;
    return;
  }

  for (const fact of items) {
    const item = document.createElement('div');
    item.className = `memory-item${fact.pinned ? ' pinned' : ''}`;
    item.innerHTML = `
      <div class="memory-item-head">
        <span class="memory-date">${escapeHtml(String(fact.createdAt || '').slice(0, 10))}</span>
        <span class="memory-item-actions">
          <button data-mem-pin="${fact.id}" class="${fact.pinned ? 'active' : ''}" title="${fact.pinned ? '取消置顶' : '置顶'}">${icon('pin')}</button>
          <button data-mem-copy="${fact.id}" title="复制">${icon('copy')}</button>
          <button data-mem-del="${fact.id}" title="删除">${icon('trash')}</button>
        </span>
      </div>
      <div class="memory-text"></div>
      <div class="memory-tags"></div>`;
    $('.memory-text', item).textContent = fact.text;
    const tags = $('.memory-tags', item);
    for (const tag of fact.tags || []) {
      const span = document.createElement('span');
      span.textContent = tag;
      tags.appendChild(span);
    }
    host.appendChild(item);
  }
}

async function addMemory(text, tags) {
  const result = await api('/api/memory', { method: 'POST', body: { text, tags } });
  await loadMemory();
  toast(result.duplicate ? '记忆库中已有相同内容' : '已加入记忆库', result.duplicate ? '' : 'ok');
}

/* ==========================================================================
   面板
   ========================================================================== */
function openDrawer(name) {
  closeDrawer();
  const drawer = name === 'settings' ? $('#settings-drawer') : $('#memory-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  const backdrop = $('#backdrop');
  backdrop.hidden = false;
  state.drawer = name;
  closeSidebar();
  closeMore();
  if (name === 'settings') {
    syncSettingsUI();
    renderRequestPreview();
  } else {
    renderMemory();
    setTimeout(() => $('#memory-text')?.focus(), 120);
  }
}

function closeDrawer() {
  for (const id of ['settings-drawer', 'memory-drawer']) {
    const drawer = $(`#${id}`);
    if (drawer) drawer.hidden = true;
  }
  state.drawer = null;
  if (!document.querySelector('.sidebar.open')) {
    const backdrop = $('#backdrop');
    if (backdrop) backdrop.hidden = true;
  }
}

function openSidebar() {
  $('#sidebar')?.classList.add('open');
  $('#backdrop').hidden = false;
  closeMore();
}

function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  if (!state.drawer) {
    const backdrop = $('#backdrop');
    if (backdrop) backdrop.hidden = true;
  }
}

function closeAllPanels() {
  closeDrawer();
  closeSidebar();
  closeMore();
}

function closeMore() {
  const menu = $('#more-menu');
  if (menu) menu.hidden = true;
  document.querySelector('[data-action="toggle-more"]')?.setAttribute('aria-expanded', 'false');
}

function toggleMore(event) {
  event.stopPropagation();
  const menu = $('#more-menu');
  if (!menu) return;
  menu.hidden = !menu.hidden;
  document.querySelector('[data-action="toggle-more"]')?.setAttribute('aria-expanded', String(!menu.hidden));
}

/* ==========================================================================
   登录
   ========================================================================== */
function showLogin() {
  const view = $('#login-view');
  if (!view) return;
  view.hidden = false;
  setTimeout(() => $('#login-token')?.focus(), 80);
}

async function submitLogin(event) {
  event.preventDefault();
  const input = $('#login-token');
  const errorEl = $('#login-error');
  const token = input?.value?.trim();
  if (!token) return;
  errorEl.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'E-dreikanterbot' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      errorEl.textContent = data?.error?.message || '登录失败';
      errorEl.hidden = false;
      return;
    }
    $('#login-view').hidden = true;
    const configRes = await fetch('/api/config');
    state.config = await configRes.json();
    await afterAuth();
    toast('欢迎回来', 'ok');
  } catch (err) {
    errorEl.textContent = err.message || '网络错误';
    errorEl.hidden = false;
  }
}

/* ==========================================================================
   关于
   ========================================================================== */
function openAbout() {
  closeMore();
  const body = document.createElement('div');
  body.className = 'about';
  body.innerHTML = `
    <p class="about-lead">按 DeepSeek 官方 API 打造的聊天机器人：零依赖、单文件启动、全设备自适应。</p>
    <div class="about-grid">
      <div><span>版本</span><strong>v${escapeHtml(state.config?.version || '1.0.0')}</strong></div>
      <div><span>默认模型</span><strong>${escapeHtml(state.config?.defaultModel || 'deepseek-flash')}</strong></div>
      <div><span>上下文</span><strong>1,000,000 tokens</strong></div>
      <div><span>最大输出</span><strong>393,216 tokens</strong></div>
    </div>
    <h4>快捷键</h4>
    <ul class="about-keys">
      <li><kbd>Enter</kbd><span>发送</span></li>
      <li><kbd>Shift</kbd> + <kbd>Enter</kbd><span>换行</span></li>
      <li><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd><span>新对话</span></li>
      <li><kbd>Esc</kbd><span>停止生成 / 关闭面板</span></li>
    </ul>
    <h4>接口</h4>
    <ul class="about-links">
      <li><code>POST /api/chat</code><span>网页使用的事件流</span></li>
      <li><code>POST /v1/chat/completions</code><span>OpenAI 兼容，Bearer ACCESS_TOKEN</span></li>
      <li><code>GET /v1/models</code><span>模型列表</span></li>
    </ul>
    <p class="about-foot">
      文档：<a href="https://github.com/Ansel-official/E-dreikanterbot" target="_blank" rel="noopener">GitHub 仓库</a>
      · <a href="https://api-docs.deepseek.com/" target="_blank" rel="noopener">DeepSeek API Docs</a>
    </p>
    <p class="about-foot" id="about-icp"></p>
  `;
  const icp = state.config?.site?.icpNumber;
  const icpEl = $('#about-icp', body);
  if (icp) {
    const link = document.createElement('a');
    link.href = state.config.site.icpLink || 'https://beian.miit.gov.cn/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = icp;
    icpEl.append(link);
  } else {
    icpEl.textContent = 'ICP 备案号未配置：公网部署前请完成备案（docs/ICP.md）。';
  }
  modal({ title: '关于 E-dreikanterbot', body, confirmText: '知道了', cancelText: '' });
}

/* ==========================================================================
   初始化
   ========================================================================== */
async function boot() {
  applyTheme();
  bindEvents();

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const shortcut = document.querySelector('.new-chat kbd');
  if (shortcut) shortcut.textContent = isMac ? '⌘K' : 'Ctrl K';

  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
  } catch (err) {
    toast('无法连接服务端，请确认 node server.js 正在运行', 'error');
    return;
  }

  if (state.config.features?.login && !state.config.authenticated) {
    showLogin();
    return;
  }

  await afterAuth();
  registerServiceWorker();
}

async function afterAuth() {
  mergeDefaults();
  renderConfigBits();
  syncSettingsUI();
  renderComposerState();
  renderUsage();

  try {
    await Promise.all([loadConversations(), loadMemory()]);
  } catch (err) {
    toast(`加载数据失败：${err.message}`, 'error');
  }

  const lastId = localStorage.getItem(STORAGE.lastConv);
  if (lastId && state.conversations.some((item) => item.id === lastId)) {
    try {
      await openConversation(lastId, true);
    } catch {
      /* 忽略失效的 lastConversation */
    }
  }

  renderMessages();
  renderConversations();
  renderConfigBits();
  autosize();
  $('#composer')?.focus();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ==========================================================================
   事件
   ========================================================================== */
function bindEvents() {
  document.addEventListener('click', onDocumentClick);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    if ($('#install-item')) $('#install-item').hidden = false;
  });

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  $('#conv-search')?.addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderConversations();
  });

  $('#conv-list')?.addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      event.stopPropagation();
      deleteConversation(del.dataset.del);
      return;
    }
    const row = event.target.closest('.conv-item');
    if (row) openConversation(row.dataset.id);
  });

  $('#conv-list')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.conv-item');
    if (row) {
      event.preventDefault();
      openConversation(row.dataset.id);
    }
  });

  $('#messages')?.addEventListener('scroll', () => {
    const near = isNearBottom();
    state.stickToBottom = near;
    if ($('#scroll-bottom')) $('#scroll-bottom').hidden = near;
  });

  $('#composer-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.streaming) {
      stopStreaming();
      return;
    }
    sendMessage();
  });

  const composer = $('#composer');
  composer?.addEventListener('input', autosize);
  composer?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!state.streaming) sendMessage();
    }
    if (event.key === 'Escape' && state.streaming) stopStreaming();
  });
  composer?.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      addImageFiles(files);
    }
  });

  const composerForm = $('#composer-form');
  composerForm?.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  composerForm?.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) addImageFiles(event.dataTransfer.files);
  });

  $('#file-input')?.addEventListener('change', (event) => {
    addImageFiles(event.target.files);
    event.target.value = '';
  });

  $('#import-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      try {
        await importConversations(file);
      } catch (err) {
        toast(err.message || '导入失败', 'error');
      }
    }
  });

  $('#composer')?.addEventListener('focus', () => {
    state.stickToBottom = true;
  });

  /* 设置面板 */
  $('#model-cards')?.addEventListener('change', (event) => {
    if (event.target.name === 'model') updateSetting({ model: event.target.value });
  });

  $('#thinking-switch')?.addEventListener('click', () => updateSetting({ thinking: !state.settings.thinking }));
  $('#json-switch')?.addEventListener('click', () => updateSetting({ json_mode: !state.settings.json_mode }));
  $('#web-search-switch')?.addEventListener('click', () =>
    updateSetting({ web_search: !state.settings.web_search }),
  );
  $('#read-url-switch')?.addEventListener('click', () => updateSetting({ read_url: !state.settings.read_url }));
  $('#memory-switch')?.addEventListener('click', () => updateSetting({ memory: !state.settings.memory }));
  $('#title-switch')?.addEventListener('click', () => updateSetting({ title: !state.settings.title }));

  $('#effort-seg')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-effort]');
    if (button && !button.disabled) updateSetting({ reasoning_effort: button.dataset.effort });
  });

  $('#token-presets')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tokens]');
    if (!button) return;
    updateSetting({ max_tokens: Number(button.dataset.tokens) });
  });

  $('#max-tokens')?.addEventListener('change', (event) => {
    const value = Math.min(393216, Math.max(1, Math.round(Number(event.target.value) || 65536)));
    updateSetting({ max_tokens: value });
  });

  $('#temperature')?.addEventListener('input', (event) => {
    state.settings.temperature = Number(event.target.value);
    $('#temperature-value').textContent = state.settings.temperature.toFixed(2);
    saveSettings();
    renderRequestPreview();
  });
  $('#top-p')?.addEventListener('input', (event) => {
    state.settings.top_p = Number(event.target.value);
    $('#top-p-value').textContent = state.settings.top_p.toFixed(2);
    saveSettings();
    renderRequestPreview();
  });

  $('#stop-sequences')?.addEventListener(
    'input',
    debounce((event) => {
      state.settings.stop = parseStop(event.target.value);
      saveSettings();
      renderRequestPreview();
    }, 300),
  );

  $('#safety-seg')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-safety]');
    if (button) updateSetting({ safety: button.dataset.safety });
  });

  $('#reset-settings')?.addEventListener('click', resetSettings);
  $('#max-settings')?.addEventListener('click', maxSettings);

  /* 记忆库 */
  $('#memory-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('#memory-text').value.trim();
    if (!text) return;
    try {
      await addMemory(text, $('#memory-tags').value);
      $('#memory-text').value = '';
      $('#memory-tags').value = '';
    } catch (err) {
      toast(err.message || '添加失败', 'error');
    }
  });

  $('#memory-search')?.addEventListener('input', (event) => {
    state.memoryFilter = event.target.value;
    renderMemory();
  });

  $('#memory-list')?.addEventListener('click', async (event) => {
    const pin = event.target.closest('[data-mem-pin]');
    const del = event.target.closest('[data-mem-del]');
    const copy = event.target.closest('[data-mem-copy]');
    const fact = state.memory.find(
      (item) => item.id === (pin?.dataset.memPin || del?.dataset.memDel || copy?.dataset.memCopy),
    );
    if (!fact) return;
    if (pin) {
      await api(`/api/memory/${fact.id}`, { method: 'PATCH', body: { pinned: !fact.pinned } });
      await loadMemory();
    } else if (del) {
      const confirmed = await confirmDelete('删除这条记忆？', fact.text.slice(0, 80));
      if (!confirmed) return;
      await api(`/api/memory/${fact.id}`, { method: 'DELETE' });
      await loadMemory();
      toast('记忆已删除', 'ok');
    } else if (copy) {
      await copyText(fact.text);
      toast('已复制记忆');
    }
  });

  /* 登录 */
  $('#login-form')?.addEventListener('submit', submitLogin);

  /* 全局快捷键 */
  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newChat();
      return;
    }
    if (event.key === 'Escape') {
      if (state.streaming) {
        stopStreaming();
        return;
      }
      closeAllPanels();
    }
  });
}

function onDocumentClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    const handlers = {
      'new-chat': () => newChat(),
      'open-settings': () => openDrawer('settings'),
      'open-memory': () => openDrawer('memory'),
      'close-drawer': () => closeDrawer(),
      'open-sidebar': () => openSidebar(),
      'close-sidebar': () => closeSidebar(),
      'toggle-theme': () => cycleTheme(),
      'toggle-more': (event) => toggleMore(event),
      'scroll-bottom': () => {
        state.stickToBottom = true;
        scrollToBottom(true);
      },
      attach: () => $('#file-input')?.click(),
      'toggle-thinking': () => updateSetting({ thinking: !state.settings.thinking }),
      'toggle-web': () =>
        updateSetting({
          web_search: !state.settings.web_search,
          read_url: !state.settings.web_search,
        }),
      'export-md': () => exportConversation('md'),
      'export-json': () => exportConversation('json'),
      import: () => $('#import-input')?.click(),
      about: () => openAbout(),
      install: async () => {
        if (!state.installPrompt) return;
        state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        if ($('#install-item')) $('#install-item').hidden = true;
      },
      logout: async () => {
        await api('/api/logout', { method: 'POST' });
        location.reload();
      },
      'max-settings': () => maxSettings(),
      'copy-code': async () => {
        const block = actionEl.closest('.code-block');
        const code = block?.querySelector('code')?.textContent || '';
        if (await copyText(code)) {
          const label = actionEl.querySelector('span');
          if (label) {
            const previous = label.textContent;
            label.textContent = '已复制';
            setTimeout(() => (label.textContent = previous), 1400);
          }
        }
      },
      'copy-message': async () => {
        const msg = findMessage(actionEl.dataset.id);
        if (!msg) return;
        await copyText(msg.content || '');
        toast('已复制');
      },
      'save-memory': async () => {
        const msg = findMessage(actionEl.dataset.id);
        if (!msg?.content) return;
        try {
          await addMemory(msg.content.slice(0, 2000), ['对话摘录']);
        } catch (err) {
          toast(err.message || '写入失败', 'error');
        }
      },
      regenerate: () => sendMessage({ regenerate: true }),
      'remove-image': () => {
        state.draftImages = state.draftImages.filter((image) => image.id !== actionEl.dataset.img);
        renderAttachments();
      },
    };
    if (handlers[action]) {
      event.preventDefault();
      handlers[action](event);
      return;
    }
  }

  const prompt = event.target.closest('[data-prompt]');
  if (prompt) {
    sendMessage({ text: prompt.dataset.prompt });
    return;
  }

  if (!event.target.closest('.more-wrap')) closeMore();
  if (event.target.id === 'backdrop') {
    closeDrawer();
    closeSidebar();
  }
}

function findMessage(id) {
  return state.messages.find((msg) => msg.id === id) || null;
}

/* 启动 */
boot();
