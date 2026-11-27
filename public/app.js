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

function formatCost(value, currency = 'USD') {
  const n = Number(value) || 0;
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (!n) return `${symbol}0`;
  if (n < 0.000001) return `<${symbol}0.000001`;
  return `${symbol}${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
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
  draftFiles: [],
  streaming: false,
  abort: null,
  lastUsage: null,
  drawer: null,
  sendSeq: 0,
  recognition: null,
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
  const catalog = config.models || [];
  const model =
    catalog.find((item) => item.id === config.defaultModel) ||
    catalog.find((item) => providerById(item.provider)?.configured) ||
    catalog[0] ||
    null;
  const meta = model;
  const maxTokens = Math.min(Number(defaults.maxTokens) || 65_536, meta?.maxOutput || 393_216);

  return {
    model: meta?.id || config.defaultModel || 'deepseek-flash',
    thinking: meta?.thinking?.mode === 'always' ? true : defaults.thinking !== false,
    reasoning_effort: meta?.thinking?.defaultEffort || defaults.reasoningEffort || 'high',
    max_tokens: maxTokens,
    temperature: defaults.temperature ?? 1,
    top_p: defaults.topP ?? 0.95,
    stop: [],
    json_mode: false,
    web_search: Boolean(meta?.capabilities?.webTools && defaults.webTools),
    read_url: Boolean(meta?.capabilities?.webTools && defaults.webTools),
    memory: defaults.memory !== false,
    title: Boolean(meta?.capabilities?.title && defaults.title),
    safety: defaults.safetyLevel === 'low' ? 'low' : 'high',
  };
}

function mergeDefaults() {
  state.settings = { ...defaultsFromConfig(), ...loadSavedSettings() };
  const selected = modelById(state.settings.model);
  if (!selected || !isProviderConfigured(selected.provider)) {
    const fallback =
      modelById(state.config?.defaultModel) ||
      (state.config?.models || []).find((item) => isProviderConfigured(item.provider)) ||
      (state.config?.models || [])[0];
    if (fallback) state.settings.model = fallback.id;
  }

  const meta = currentModel();
  if (meta) {
    if (meta.thinking.mode === 'always') state.settings.thinking = true;
    if (!meta.thinking.efforts.includes(state.settings.reasoning_effort)) {
      state.settings.reasoning_effort = meta.thinking.defaultEffort || 'high';
    }
    state.settings.max_tokens = Math.min(
      Number(state.settings.max_tokens) || 65_536,
      meta.maxOutput || 393_216,
    );
    if (!meta.capabilities.webTools) {
      state.settings.web_search = false;
      state.settings.read_url = false;
    }
    if (!meta.capabilities.title) state.settings.title = false;
  }
  state.settings.stop = Array.isArray(state.settings.stop) ? state.settings.stop.slice(0, 16) : [];
}

function modelById(id) {
  return (state.config?.models || []).find((model) => model.id === id) || null;
}

function providerById(id) {
  return (state.config?.providers || []).find((provider) => provider.id === id) || null;
}

function isProviderConfigured(providerId) {
  return Boolean(providerById(providerId)?.configured);
}

function currentModel() {
  return modelById(state.settings.model) || (state.config?.models || [])[0] || null;
}

function modelShortName(meta) {
  if (!meta) return '—';
  const map = {
    'deepseek-flash': 'flash',
    'deepseek-v4-pro': 'pro',
    'kimi-k3.1-pro': 'k3.1',
    'kimi-k3.1-pro-highspeed': 'k3.1-fast',
    'kimi-k3': 'k3',
    'kimi-k2.7-code': 'k2.7',
    'kimi-k2.7-code-highspeed': 'k2.7-fast',
    'kimi-k2.6': 'k2.6',
  };
  return map[meta.id] || meta.id;
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
  const meta = currentModel();
  const maxTokens = Math.min(
    meta?.maxOutput || 393_216,
    Math.max(1, Math.round(Number(state.settings.max_tokens) || 65_536)),
  );
  return {
    model: state.settings.model,
    thinking: Boolean(state.settings.thinking),
    reasoning_effort: state.settings.thinking ? state.settings.reasoning_effort : 'none',
    max_tokens: maxTokens,
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

const MODEL_ORDER = {
  'deepseek-flash': 0,
  'deepseek-v4-pro': 1,
  'kimi-k3.1-pro': 0,
  'kimi-k3': 1,
  'kimi-k2.7-code': 2,
  'kimi-k2.7-code-highspeed': 3,
  'kimi-k2.6': 4,
};

function modelOrder(a, b) {
  return (MODEL_ORDER[a] ?? 99) - (MODEL_ORDER[b] ?? 99) || String(a).localeCompare(String(b));
}

function renderModelList() {
  const host = $('#model-picker-list');
  if (!host) return;
  const providers = state.config?.providers || [];
  if (!providers.length) {
    host.innerHTML = '<div class="memory-empty">暂无可用模型</div>';
    return;
  }

  host.innerHTML = '';
  for (const provider of providers) {
    const group = document.createElement('div');
    group.className = 'model-pick-group';
    const head = document.createElement('div');
    head.className = 'model-pick-provider';
    head.innerHTML =
      `<span>${escapeHtml(provider.name)}</span>` +
      `<span class="model-pick-status ${provider.configured ? '' : 'off'}">` +
      `${provider.configured ? (provider.error ? '降级' : '可用') : '未配置'}</span>`;
    group.appendChild(head);

    for (const modelId of [...provider.models].sort(modelOrder)) {
      const meta = modelById(modelId);
      if (!meta) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-pick${state.settings.model === meta.id ? ' selected' : ''}`;
      button.dataset.model = meta.id;
      button.disabled = !provider.configured;

      const bits = [formatContext(meta.contextWindow)];
      if (meta.capabilities.vision) bits.push('视觉');
      if (meta.thinking.mode === 'always') bits.push('始终思考');
      else if (meta.thinking.mode === 'optional') bits.push('可关思考');
      if (meta.deprecated) bits.push('即将下线');

      button.innerHTML =
        '<span class="model-pick-main">' +
        `<span class="model-pick-name">${escapeHtml(meta.name)}</span>` +
        `<span class="model-pick-meta">${escapeHtml(bits.join(' · '))}</span>` +
        '</span>' +
        `<span class="model-pick-check">${icon('check')}</span>`;
      group.appendChild(button);
    }
    host.appendChild(group);
  }
}

function selectModel(modelId) {
  const meta = modelById(modelId);
  if (!meta) return;
  if (!isProviderConfigured(meta.provider)) {
    const provider = providerById(meta.provider);
    toast(`${provider?.name || meta.provider} 尚未配置 API Key`, 'error');
    return;
  }
  const patch = {
    model: meta.id,
    max_tokens: Math.min(Number(state.settings.max_tokens) || meta.maxOutput, meta.maxOutput),
  };
  if (meta.thinking.mode === 'always') patch.thinking = true;
  if (!meta.thinking.efforts.includes(state.settings.reasoning_effort)) {
    patch.reasoning_effort = meta.thinking.defaultEffort || 'high';
  }
  if (!meta.capabilities.webTools) {
    patch.web_search = false;
    patch.read_url = false;
  }
  if (!meta.capabilities.title) patch.title = false;
  updateSetting(patch);
  closeModelPicker();
}

const EFFORT_LABELS = { low: '快速', high: '均衡', max: '深入' };

/** 滑条档位：可关思考的模型多一个“关闭”，始终思考的模型只有强度档。 */
function effortSteps(meta) {
  const efforts = (meta?.thinking?.efforts || []).filter((effort) => EFFORT_LABELS[effort]);
  if (!efforts.length) return [];
  const levels = efforts.map((value) => ({ value, label: EFFORT_LABELS[value] }));
  if (meta.thinking.mode === 'always') return levels;
  return [{ value: 'none', label: '关闭' }, ...levels];
}

function renderEffortControl() {
  const control = $('#effort-control');
  const slider = $('#effort-slider');
  const label = $('#effort-label');
  if (!control || !slider || !label) return;
  const meta = currentModel();
  const steps = effortSteps(meta);
  if (!steps.length) {
    control.hidden = true;
    return;
  }
  control.hidden = false;
  const current = state.settings.thinking ? state.settings.reasoning_effort : 'none';
  let index = steps.findIndex((step) => step.value === current);
  if (index < 0) index = steps.findIndex((step) => step.value === meta?.thinking.defaultEffort);
  if (index < 0) index = steps.length - 1;
  slider.min = '0';
  slider.max = String(steps.length - 1);
  slider.value = String(index);
  slider.disabled = steps.length < 2;
  label.textContent = steps[index].label;
  slider.setAttribute('aria-valuetext', steps[index].label);
  slider.title = `推理强度：${steps[index].label}`;
}

function toggleModelPicker(event) {
  event?.stopPropagation();
  const popover = $('#model-popover');
  if (!popover) return;
  const willOpen = popover.hidden;
  if (willOpen) renderModelList();
  popover.hidden = !willOpen;
  $('#model-picker-btn')?.setAttribute('aria-expanded', String(willOpen));
  closeMore();
}

function closeModelPicker() {
  const popover = $('#model-popover');
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  $('#model-picker-btn')?.setAttribute('aria-expanded', 'false');
}

function syncSettingsUI() {
  if (!state.settings.model) return;
  const s = state.settings;
  const meta = currentModel();

  renderModelList();

  const canEffort = Boolean(meta?.thinking.efforts.length);
  const alwaysThinking = meta?.thinking.mode === 'always';
  $$('#effort-seg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.effort === s.reasoning_effort);
    button.disabled = !s.thinking || !canEffort || !meta.thinking.efforts.includes(button.dataset.effort);
  });

  if ($('#max-tokens')) {
    const max = meta?.maxOutput || 393_216;
    const value = Math.min(Number(s.max_tokens) || max, max);
    s.max_tokens = value;
    $('#max-tokens').max = String(max);
    $('#max-tokens').value = String(value);
  }
  $$('#token-presets button').forEach((button) => {
    button.classList.toggle('accent', Number(button.dataset.tokens) === Number(s.max_tokens));
  });

  const fixedSampling = meta?.provider === 'kimi';
  if ($('#temperature')) {
    $('#temperature').value = String(s.temperature);
    $('#temperature-value').textContent = Number(s.temperature).toFixed(2);
    $('#temperature').disabled = fixedSampling || Boolean(s.thinking);
  }
  if ($('#top-p')) {
    $('#top-p').value = String(s.top_p);
    $('#top-p-value').textContent = Number(s.top_p).toFixed(2);
    $('#top-p').disabled = fixedSampling || Boolean(s.thinking);
  }
  if ($('#stop-sequences') && document.activeElement !== $('#stop-sequences')) {
    $('#stop-sequences').value = (s.stop || []).join('\n');
  }

  const thinkingSwitch = $('#thinking-switch');
  if (thinkingSwitch) {
    thinkingSwitch.setAttribute('aria-checked', String(alwaysThinking ? true : Boolean(s.thinking)));
    thinkingSwitch.disabled = alwaysThinking;
    thinkingSwitch.title = alwaysThinking ? '该模型始终开启思考' : '';
  }
  setSwitch('#json-switch', s.json_mode);
  setSwitch('#web-search-switch', s.web_search);
  setSwitch('#read-url-switch', s.read_url);
  setSwitch('#memory-switch', s.memory);
  setSwitch('#title-switch', s.title);

  const webAllowed = Boolean(meta?.capabilities.webTools);
  for (const selector of ['#web-search-switch', '#read-url-switch']) {
    const el = $(selector);
    if (el) {
      el.disabled = !webAllowed;
      el.title = webAllowed ? '' : 'Kimi 不提供 DeepSeek 的 web tools；请使用 Kimi 官方工具方案';
    }
  }
  const titleSwitch = $('#title-switch');
  if (titleSwitch) {
    titleSwitch.disabled = !meta?.capabilities.title;
    titleSwitch.title = meta?.capabilities.title ? '' : 'Kimi 不支持 title 扩展';
  }

  $$('#safety-seg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.safety === s.safety);
    button.disabled = !meta?.capabilities.safetyCheck;
    button.title = meta?.capabilities.safetyCheck ? '' : 'Kimi 不提供 safety_check';
  });

  const chip = $('#model-chip');
  if (chip) {
    chip.textContent = modelShortName(meta);
    chip.dataset.provider = meta?.provider || '';
    chip.title = meta ? `${meta.providerName} · ${meta.name}` : '';
  }
  const pickerBtn = $('#model-picker-btn');
  const pickerLabel = $('#model-picker-label');
  const pickerDot = $('#model-dot');
  if (pickerLabel) pickerLabel.textContent = meta?.name || '选择模型';
  if (pickerDot) pickerDot.dataset.provider = meta?.provider || '';
  if (pickerBtn) pickerBtn.title = meta ? `${meta.providerName} · ${meta.name}` : '切换模型';
  renderEffortControl();

  const metaHost = $('#model-meta');
  if (metaHost) {
    if (meta) {
      const thinkText =
        meta.thinking.mode === 'always'
          ? '始终思考'
          : meta.thinking.mode === 'optional'
            ? '思考可关闭'
            : '思考可开关';
      metaHost.innerHTML =
        `<strong>${escapeHtml(meta.providerName)} · ${escapeHtml(meta.name)}</strong><br>` +
        `上下文 ${formatContext(meta.contextWindow)} · 最大输出 ${formatTokens(meta.maxOutput)} · ` +
        `${meta.capabilities.vision ? '支持视觉' : '纯文本'} · ${thinkText}`;
    } else {
      metaHost.textContent = '未找到模型元数据';
    }
  }

  const maxHint = $('#max-tokens-hint');
  if (maxHint && meta) {
    maxHint.textContent =
      meta.provider === 'kimi'
        ? `Kimi 官方 max_completion_tokens 上限 ${meta.maxOutput.toLocaleString()}，默认 131072。`
        : `官方上限 ${meta.maxOutput.toLocaleString()}（384K）。实际消耗以 API 返回的 usage 为准。`;
  }
  const thinkHint = $('#thinking-hint');
  if (thinkHint && meta) {
    thinkHint.textContent =
      meta.thinking.mode === 'always'
        ? 'Kimi K3 系列始终开启 Preserved Thinking，只可调 reasoning_effort（默认 max）。'
        : meta.thinking.mode === 'optional'
          ? 'Kimi K2.6 可关闭思考；关闭后不返回 reasoning_content。'
          : '思考模式下 temperature / top_p 会被 DeepSeek 官方忽略，这是预期行为。';
  }
  const safetyHint = $('#safety-hint');
  if (safetyHint && meta) {
    safetyHint.textContent = meta.capabilities.safetyCheck
      ? '面向公众提供服务时，请保持 high 并落实内容审核、生成式 AI 备案与标识义务。'
      : 'Kimi 不提供 safety_check，改用 safety_identifier；内容审核与备案义务仍需你自行落实。';
  }

  renderRequestPreview();
}

function setSwitch(selector, value) {
  $(selector)?.setAttribute('aria-checked', String(Boolean(value)));
}

function formatContext(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M`;
  return `${Math.round(n / 1024)}K`;
}

function renderRequestPreview() {
  const pre = $('#request-preview');
  if (!pre || !state.settings.model) return;
  const s = state.settings;
  const meta = currentModel();
  const payload = {
    model: s.model,
    messages: [
      { role: 'system', content: '（人设 + 记忆库 Top-K + 日期，由服务端拼装）' },
      { role: 'user', content: '（你的消息）' },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };

  if (meta?.provider === 'kimi') {
    payload.max_completion_tokens = Number(s.max_tokens);
    if (meta.thinking.mode === 'always') {
      payload.reasoning_effort = s.reasoning_effort;
    } else if (meta.thinking.mode === 'optional') {
      payload.thinking = { type: s.thinking ? 'enabled' : 'disabled', keep: 'all' };
    }
    payload.prompt_cache_key = '（当前会话 id）';
    payload.safety_identifier = state.clientId;
    if (s.stop?.length) payload.stop = s.stop.slice(0, 5);
    if (s.json_mode) payload.response_format = { type: 'json_object' };
    const tools = [];
    if (s.memory) tools.push('remember_fact', 'recall_memory');
    if (tools.length) payload.tools = tools.map((name) => `…${name}`);
  } else {
    payload.thinking = { type: s.thinking ? 'enabled' : 'disabled' };
    payload.max_tokens = Number(s.max_tokens);
    payload.user_id = state.clientId;
    if (s.thinking) payload.reasoning_effort = s.reasoning_effort;
    else {
      payload.temperature = Number(s.temperature);
      payload.top_p = Number(s.top_p);
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
  }

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
  const meta = currentModel();
  const efforts = meta?.thinking.efforts || [];
  Object.assign(state.settings, {
    thinking: true,
    reasoning_effort: efforts.includes('max') ? 'max' : efforts.at(-1) || 'high',
    max_tokens: meta?.maxOutput || 393_216,
    temperature: 1,
    top_p: 1,
    json_mode: false,
    web_search: Boolean(meta?.capabilities.webTools),
    read_url: Boolean(meta?.capabilities.webTools),
    memory: true,
    title: Boolean(meta?.capabilities.title),
    safety: 'high',
  });
  saveSettings();
  syncSettingsUI();
  renderComposerState();
  toast(`已拉满：${meta?.name || state.settings.model} · 最大输出 ${formatTokens(meta?.maxOutput || 393_216)}`);
}

/* ==========================================================================
   渲染：配置 / 侧栏
   ========================================================================== */
function renderConfigBits() {
  const config = state.config;
  if (!config) return;
  const site = config.site || {};

  if ($('#site-name')) $('#site-name').textContent = site.name || 'E-dreikanterbot';
  if ($('#foot-version')) $('#foot-version').textContent = `v${config.version || '2.2.0'}`;
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
        `${icon('key')}<div><strong>还没有配置上游 API Key</strong><br />` +
        `在项目根目录执行 <code>cp .env.example .env</code>，填入 <code>DEEPSEEK_API_KEY</code>（DeepSeek）或 <code>KIMI_API_KEY</code>（Kimi）后重启服务。` +
        `<br /><a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">DeepSeek Key</a>` +
        ` · <a href="https://platform.moonshot.cn/console/api-keys" target="_blank" rel="noopener">Kimi Key</a></div>`;
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
function activePath(doc) {
  if (!doc) return [];
  const messages = doc.messages || [];
  if (doc.rootMessageId === undefined) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
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

function visibleMessages(doc) {
  return activePath(doc)
    .filter((msg) => !msg.hidden && (msg.role === 'user' || msg.role === 'assistant'))
    .map((msg) => ({ ...msg }));
}

function versionsFor(msg) {
  const all = state.current?.messages || [];
  const siblings = all
    .filter((item) => (item.parentId ?? null) === (msg.parentId ?? null) && item.role === msg.role)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return {
    ids: siblings.map((item) => item.id),
    index: Math.max(0, siblings.findIndex((item) => item.id === msg.id)),
    count: siblings.length,
  };
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
    const el = messageEl(msg, {
      isLastAssistant: lastAssistant && lastAssistant.id === msg.id,
      versions: versionsFor(msg),
    });
    if (el) frag.appendChild(el);
  }
  host.appendChild(frag);

  if (state.streaming || nearBottom || state.stickToBottom) {
    requestAnimationFrame(() => scrollToBottom(true));
  }
}

function emptyState() {
  const suggestions = [
    { icon: 'spark', label: '解释一个概念', prompt: '把量子纠缠讲给高中生听，用一个生活化比喻。' },
    { icon: 'edit', label: '写一段代码', prompt: '用 TypeScript 写一个带重试与超时控制的 fetch 封装，并解释设计取舍。' },
    { icon: 'link', label: '读一个网页', prompt: '请读取 https://api-docs.deepseek.com/ ，总结核心能力并给出三个上手建议。' },
    { icon: 'brain', label: '记住一个偏好', prompt: '请记住：我偏好中文回答，代码示例用 TypeScript，先给结论再解释。' },
  ];
  const wrapper = document.createElement('div');
  wrapper.className = 'empty';
  wrapper.innerHTML = `
    <div class="empty-mark" aria-hidden="true">E</div>
    <h1>今天想聊什么？</h1>
    <p class="lead">DeepSeek / Kimi · 记忆、分支和草稿都会保留</p>
    <div class="suggestions">
      ${suggestions
        .map(
          (item) =>
            `<button class="suggestion" data-prompt="${escapeHtml(item.prompt)}">` +
            `${icon(item.icon)}<span>${escapeHtml(item.label)}</span></button>`,
        )
        .join('')}
    </div>`;
  return wrapper;
}

function branchHtml(versions) {
  if (!versions || versions.count < 2) return '';
  return (
    '<span class="branch-switch">' +
    `<button type="button" data-action="branch" data-dir="-1" title="上一版本">${icon('arrow-left')}</button>` +
    `<span class="branch-count">${versions.index + 1}/${versions.count}</span>` +
    `<button type="button" data-action="branch" data-dir="1" title="下一版本">${icon('arrow-right')}</button>` +
    '</span>'
  );
}

function messageEl(msg, { isLastAssistant = false, versions = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;
  wrap.dataset.msgId = msg.id;

  if (msg.role === 'user') {
    wrap.innerHTML = `
      <div class="msg-body">
        <div class="msg-head"><span class="msg-name">你</span><span class="msg-time">${formatTime(msg.createdAt)}</span>${branchHtml(versions)}
          <span class="msg-actions">
            <button data-action="copy-message" data-id="${escapeHtml(msg.id)}" title="复制">${icon('copy')}</button>
            <button data-action="edit-message" data-id="${escapeHtml(msg.id)}" title="编辑并重新生成">${icon('edit')}</button>
            <button data-action="save-memory" data-id="${escapeHtml(msg.id)}" title="存入记忆库">${icon('brain')}</button>
          </span>
        </div>
        <div class="user-images" hidden></div>
        <div class="user-files" hidden></div>
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
    const filesHost = $('.user-files', wrap);
    if (msg.files?.length) {
      filesHost.hidden = false;
      for (const file of msg.files) {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        chip.innerHTML = `${icon('file')}<span></span><small>${formatBytes(file.size || file.text?.length || 0)}</small>`;
        $('span', chip).textContent = file.name;
        chip.title = file.name;
        filesHost.appendChild(chip);
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
        ${branchHtml(versions)}
        <span class="msg-actions">
          <button data-action="copy-message" data-id="${escapeHtml(msg.id)}" title="复制回答">${icon('copy')}</button>
          <button data-action="read-aloud" data-id="${escapeHtml(msg.id)}" title="朗读">${icon('speaker')}</button>
          <button data-action="save-memory" data-id="${escapeHtml(msg.id)}" title="存入记忆库">${icon('brain')}</button>
          ${isLastAssistant && !msg.streaming ? `<button data-action="regenerate" data-id="${escapeHtml(msg.id)}" title="重新生成">${icon('refresh')}</button>` : ''}
          ${isLastAssistant && !msg.streaming && (msg.finishReason === 'length' || msg.aborted) ? `<button data-action="continue" data-id="${escapeHtml(msg.id)}" title="继续生成">${icon('arrow-right')}</button>` : ''}
        </span>
      </div>
      <div class="thinking-slot"></div>
      <div class="tool-slot"></div>
      <div class="error-slot"></div>
      <div class="md${msg.streaming ? ' streaming' : ''}"></div>
      <div class="citations" hidden></div>
      <div class="msg-foot"></div>
    </div>`;

  const md = $('.md', wrap);
  if (msg.content) md.innerHTML = renderMarkdown(msg.content);
  else if (msg.streaming) md.innerHTML = '<p class="muted">…</p>';

  const citations = Array.isArray(msg.annotations)
    ? msg.annotations
        .filter((item) => item && /^https?:\/\//i.test(String(item.url || '')))
        .slice(0, 8)
    : [];
  if (citations.length) {
    const host = $('.citations', wrap);
    host.hidden = false;
    host.innerHTML = `<span class="citations-label">来源</span>${citations
      .map((item, index) => {
        let label = item.title || '';
        if (!label) {
          try {
            label = new URL(item.url).hostname;
          } catch {
            label = `来源 ${index + 1}`;
          }
        }
        return `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      })
      .join('')}`;
  }

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
  const usage = msg.usage;
  if (!usage && !msg.aborted) return '';
  const parts = [];
  let detail = '';
  if (usage) {
    parts.push(`↑ ${formatTokens(usage.prompt_tokens)}`);
    parts.push(`↓ ${formatTokens(usage.completion_tokens)}`);
    if (usage.cost) parts.push(formatCost(usage.cost, usage.currency));
    const cached = Number(usage.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
    const cachePct = usage.prompt_tokens ? Math.round((cached / usage.prompt_tokens) * 100) : 0;
    detail = [
      `缓存 ${cachePct}%`,
      usage.cache_write_tokens ? `写入 ${formatTokens(usage.cache_write_tokens)}` : '',
      usage.elapsedMs ? formatDuration(usage.elapsedMs) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (msg.aborted) parts.push('已停止');
  return `<span title="${escapeHtml(detail)}">${parts.map((part) => escapeHtml(part)).join(' · ')}</span>`;
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
  if (usage.cache_write_tokens) pieces.push(`写缓存 ${formatTokens(usage.cache_write_tokens)}`);
  if (usage.cost) pieces.push(formatCost(usage.cost, usage.currency));
  if (usage.elapsedMs) pieces.push(formatDuration(usage.elapsedMs));
  $('#usage-text').textContent = pieces.join(' · ');

  const isKimi = usage.currency === 'CNY';
  const tier = isKimi ? '' : usage.costDetail?.tier || state.config?.pricing?.tier || '';
  const tierEl = $('#usage-tier');
  tierEl.textContent = isKimi ? 'Kimi 计价' : tier === 'peak' ? '高峰计价' : tier ? '低峰计价' : '';
  tierEl.className = `usage-tier ${tier === 'peak' ? 'peak' : ''}`;
  tierEl.title = isKimi ? 'Kimi 费用请以 Moonshot 控制台账单为准' : '按官方 UTC 高峰时段估算，未扣除法定节假日';
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
  const meta = currentModel();
  const alwaysThinking = meta?.thinking.mode === 'always';
  const thinkingBtn = $('#thinking-toggle');
  const webBtn = $('#web-toggle');
  if (thinkingBtn) {
    thinkingBtn.classList.toggle('on', alwaysThinking || Boolean(state.settings.thinking));
    thinkingBtn.setAttribute('aria-pressed', String(alwaysThinking || Boolean(state.settings.thinking)));
    thinkingBtn.disabled = alwaysThinking;
    thinkingBtn.title = alwaysThinking ? '该模型始终思考' : '切换深度思考';
  }
  if (webBtn) {
    webBtn.classList.toggle('on', Boolean(state.settings.web_search));
    webBtn.setAttribute('aria-pressed', String(Boolean(state.settings.web_search)));
    webBtn.disabled = !meta?.capabilities.webTools;
    webBtn.title = meta?.capabilities.webTools ? '切换联网搜索' : '当前模型不支持 DeepSeek web tools';
  }
}

function renderAttachments() {
  const host = $('#attachments');
  if (!host) return;
  host.hidden = !state.draftImages.length && !state.draftFiles.length;
  host.innerHTML = '';
  for (const image of state.draftImages) {
    const item = document.createElement('div');
    item.className = 'attachment';
    item.innerHTML = `<img alt="待发送图片" src="${image.dataUrl}" /><button type="button" data-action="remove-image" data-img="${image.id}" aria-label="移除">${icon('x')}</button>`;
    host.appendChild(item);
  }
  for (const file of state.draftFiles) {
    const item = document.createElement('div');
    item.className = 'file-chip';
    item.innerHTML = `${icon('file')}<span></span><small>${formatBytes(file.size)}</small><button type="button" data-action="remove-file" data-file="${file.id}" aria-label="移除">${icon('x')}</button>`;
    $('span', item).textContent = file.name;
    $('span', item).title = file.name;
    host.appendChild(item);
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}

async function addFiles(files, { imagesOnly = false } = {}) {
  const list = [...files];
  if (!list.length) return;
  let textTotal = state.draftFiles.reduce((sum, file) => sum + file.text.length, 0);
  for (const file of list) {
    if (file.type?.startsWith('image/')) {
      if (state.draftImages.length >= 4) {
        toast('最多同时发送 4 张图片', 'error');
        continue;
      }
      try {
        const dataUrl = await prepareImage(file);
        state.draftImages.push({ id: uid('img'), dataUrl });
      } catch (err) {
        toast(err.message || '图片处理失败', 'error');
      }
      continue;
    }
    if (imagesOnly) continue;
    const isText =
      /\.(txt|md|markdown|csv|json|log)$/i.test(file.name) ||
      file.type === 'text/plain' ||
      file.type === 'text/markdown' ||
      file.type === 'application/json' ||
      file.type === 'text/csv';
    if (!isText) {
      toast(`暂不支持 ${file.name}（当前支持图片与 txt/md/csv/json/log）`, 'error');
      continue;
    }
    if (state.draftFiles.length >= 4) {
      toast('最多同时发送 4 个文本附件', 'error');
      break;
    }
    if (file.size > 400 * 1024) {
      toast(`${file.name} 超过 400KB`, 'error');
      continue;
    }
    const text = await file.text();
    if (!text.trim()) continue;
    if (text.length > 200_000 || textTotal + text.length > 500_000) {
      toast(`文本附件总长度超过限制（500k 字符）`, 'error');
      break;
    }
    textTotal += text.length;
    state.draftFiles.push({ id: uid('file'), name: file.name, size: text.length, text });
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
async function sendMessage({ text = null, regenerate = false, editMessageId = null, continuing = false } = {}) {
  if (state.streaming) {
    toast('正在生成，请先停止');
    return;
  }
  if (!state.config?.features?.keyConfigured) {
    toast('服务端未配置任何上游 API Key（DeepSeek / Kimi）', 'error');
    return;
  }
  if ((editMessageId || continuing) && !state.current?.id) {
    toast('当前没有可操作的对话', 'error');
    return;
  }
  const meta = currentModel();
  if (meta && !isProviderConfigured(meta.provider)) {
    toast(`${meta.providerName} 尚未配置 API Key`, 'error');
    return;
  }

  const content = (text ?? $('#composer').value).trim();
  const images = regenerate || continuing ? [] : state.draftImages.map((image) => image.dataUrl);
  const textFiles =
    regenerate || continuing
      ? []
      : state.draftFiles.map((file) => ({ name: file.name, text: file.text, size: file.text.length }));
  if (!regenerate && !continuing && !content && !images.length && !textFiles.length) return;
  if (editMessageId && !content) {
    toast('编辑后的内容不能为空', 'error');
    return;
  }
  if (images.length && meta && !meta.capabilities.vision) {
    toast(`${meta.name} 不支持图片，请切换到视觉模型`, 'error');
    return;
  }
  if (content.length > 100_000) {
    toast('单条消息不能超过 10 万字符', 'error');
    return;
  }

  if (continuing) {
    // 续写不新增可见用户消息，服务端会插入隐藏续写指令。
  } else if (editMessageId) {
    const index = state.messages.findIndex((item) => item.id === editMessageId);
    if (index >= 0) state.messages = state.messages.slice(0, index);
    state.messages.push({
      id: uid('local'),
      role: 'user',
      content,
      attachments: images.map((dataUrl) => ({ preview: dataUrl })),
      files: textFiles,
      createdAt: new Date().toISOString(),
    });
  } else if (!regenerate) {
    state.messages.push({
      id: uid('local'),
      role: 'user',
      content,
      attachments: images.map((dataUrl) => ({ preview: dataUrl })),
      files: textFiles,
      createdAt: new Date().toISOString(),
    });
  } else {
    while (state.messages.length && state.messages.at(-1).role === 'assistant') state.messages.pop();
  }

  if (!state.current) state.current = { id: null, title: '', messages: [] };
  if (!continuing && (!state.current.title || state.current.title === '新对话')) {
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

  if (!regenerate && !continuing) {
    $('#composer').value = '';
    state.draftImages = [];
    state.draftFiles = [];
    renderAttachments();
    autosize();
  }
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
        textFiles,
        regenerate,
        editMessageId: editMessageId || undefined,
        continue: continuing || undefined,
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
    if (seq === state.sendSeq && gotMeta && !assistant.error) {
      await refreshCurrent();
    }
  }
}

function stopStreaming() {
  state.abort?.abort();
}

async function switchBranch(messageId, direction) {
  if (!state.current?.id) return;
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  const versions = versionsFor(message);
  const targetId = versions.ids[versions.index + direction];
  if (!targetId) return;
  try {
    const data = await api(`/api/conversations/${state.current.id}/select`, {
      method: 'POST',
      body: { messageId: targetId },
    });
    state.current = data.data;
    state.messages = visibleMessages(data.data);
    state.lastUsage = [...state.messages].reverse().find((item) => item.usage)?.usage || state.lastUsage;
    renderMessages();
    renderUsage();
    renderConversations();
  } catch (err) {
    toast(err.message || '切换版本失败', 'error');
  }
}

function editMessage(id) {
  const message = findMessage(id);
  if (!message || message.role !== 'user') return;
  const box = document.createElement('textarea');
  box.className = 'edit-box';
  box.value = message.content || '';
  const wrap = document.createElement('div');
  wrap.appendChild(box);
  setTimeout(() => {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, 60);
  modal({ title: '编辑提问', body: wrap, confirmText: '保存并重新生成', cancelText: '取消' }).then((ok) => {
    if (!ok) return;
    const text = box.value.trim();
    if (!text) {
      toast('内容不能为空', 'error');
      return;
    }
    sendMessage({ text, editMessageId: message.id });
  });
}

function readAloud(text) {
  if (!('speechSynthesis' in window)) {
    toast('当前浏览器不支持朗读', 'error');
    return;
  }
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .slice(0, 4000);
  if (!clean.trim()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}

function startVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    toast('当前浏览器不支持语音识别，请使用 Chrome / Edge', 'error');
    return;
  }
  if (state.recognition) {
    state.recognition.stop();
    return;
  }
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  const base = $('#composer').value;
  const button = $('#voice-btn');

  recognition.onstart = () => button?.classList.add('recording');
  recognition.onresult = (event) => {
    let finalText = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    $('#composer').value = `${base ? `${base} ` : ''}${finalText}${interim}`;
    autosize();
  };
  recognition.onerror = (event) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      toast(`语音识别失败：${event.error}`, 'error');
    }
  };
  recognition.onend = () => {
    state.recognition = null;
    button?.classList.remove('recording');
  };
  state.recognition = recognition;
  recognition.start();
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
  state.messages = visibleMessages(doc);
  state.lastUsage = [...state.messages].reverse().find((msg) => msg.usage)?.usage || null;
  localStorage.setItem(STORAGE.lastConv, id);
  if ($('#chat-title')) $('#chat-title').textContent = doc.title || '新对话';
  renderMessages();
  renderUsage();
  renderConversations();
  if (!silent) closeAllPanels();
  scrollToBottom(true);
}

/** 流式结束后刷新服务端会话，拿到分支/兄弟版本与最终消息 id。 */
async function refreshCurrent() {
  const id = state.current?.id;
  if (!id) return;
  try {
    const data = await api(`/api/conversations/${id}`);
    if (state.current?.id !== id) return;
    state.current = data.data;
    state.messages = visibleMessages(data.data);
    state.lastUsage = [...state.messages].reverse().find((msg) => msg.usage)?.usage || state.lastUsage;
    renderMessages();
    renderUsage();
    renderConversations();
  } catch {
    /* 保留本地消息 */
  }
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
  state.draftFiles = [];
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

function openReadUrl() {
  const input = document.createElement('input');
  input.className = 'text-input';
  input.type = 'url';
  input.placeholder = 'https://example.com/article';
  const wrap = document.createElement('div');
  wrap.appendChild(input);
  setTimeout(() => input.focus(), 60);
  modal({ title: '读取网页', body: wrap, confirmText: '读取并加入附件' }).then(async (ok) => {
    if (!ok) return;
    const target = input.value.trim();
    if (!target) return;
    if (state.draftFiles.length >= 4) {
      toast('附件已达上限（4 个）', 'error');
      return;
    }
    toast('正在读取网页…');
    try {
      const result = await api('/api/read-url', { method: 'POST', body: { url: target } });
      const data = result.data;
      state.draftFiles.push({
        id: uid('file'),
        name: `${data.title || '网页'}.txt`,
        size: data.text.length,
        text: `来源：${data.url}\n标题：${data.title}\n\n${data.text}`,
      });
      renderAttachments();
      toast(`已读取 ${data.chars} 字符，作为附件发送`, 'ok');
    } catch (err) {
      toast(err.message || '读取网页失败', 'error');
    }
  });
}

function rememberConversation() {
  if (!state.current?.id) {
    toast('当前没有对话', 'error');
    return;
  }
  const users = state.messages
    .filter((message) => message.role === 'user' && message.content)
    .slice(-6)
    .map((message) => `- ${message.content}`)
    .join('\n');
  const assistant = [...state.messages].reverse().find((message) => message.role === 'assistant' && message.content);
  const box = document.createElement('textarea');
  box.className = 'edit-box';
  box.value = [
    `对话主题：${state.current.title || '未命名'}`,
    users ? `用户提到：\n${users}` : '',
    assistant ? `结论摘要：\n${String(assistant.content).slice(0, 600)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 1900);
  const wrap = document.createElement('div');
  wrap.appendChild(box);
  setTimeout(() => box.focus(), 60);
  modal({ title: '记住这段对话', body: wrap, confirmText: '写入记忆库' }).then(async (ok) => {
    if (!ok) return;
    const text = box.value.trim();
    if (!text) return;
    try {
      await addMemory(text, ['对话摘要']);
    } catch (err) {
      toast(err.message || '写入失败', 'error');
    }
  });
}

function exportMemory() {
  const link = document.createElement('a');
  link.href = '/api/memory/export';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast('正在导出记忆库');
}

async function importMemory(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    toast('记忆文件不是合法 JSON', 'error');
    return;
  }
  const result = await api('/api/memory/import', { method: 'POST', body: payload });
  await loadMemory();
  toast(`已导入 ${result.added} 条记忆`, 'ok');
}

/* ==========================================================================
   面板
   ========================================================================== */
function openDrawer(name) {
  closeDrawer();
  closeModelPicker();
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
  closeModelPicker();
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
  closeModelPicker();
}

function closeMore() {
  const menu = $('#more-menu');
  if (menu) menu.hidden = true;
  document.querySelector('[data-action="toggle-more"]')?.setAttribute('aria-expanded', 'false');
}

function toggleMore(event) {
  event.stopPropagation();
  closeModelPicker();
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
  const meta = currentModel();
  const body = document.createElement('div');
  body.className = 'about';
  body.innerHTML = `
    <p class="about-lead">DeepSeek + Kimi 双 Provider 聊天机器人，零依赖、单文件启动；模型与推理强度在输入框下方直接切换。</p>
    <div class="about-grid">
      <div><span>版本</span><strong>v${escapeHtml(state.config?.version || '2.2.0')}</strong></div>
      <div><span>当前模型</span><strong>${escapeHtml(meta?.name || state.config?.defaultModel || '—')}</strong></div>
      <div><span>上下文</span><strong>${meta ? formatContext(meta.contextWindow) : '—'} tokens</strong></div>
      <div><span>最大输出</span><strong>${meta ? formatTokens(meta.maxOutput) : '—'} tokens</strong></div>
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
      · <a href="https://platform.kimi.com/docs" target="_blank" rel="noopener">Kimi API Docs</a>
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
      addFiles(files, { imagesOnly: true });
    }
  });

  const composerForm = $('#composer-form');
  composerForm?.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  composerForm?.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });

  $('#file-input')?.addEventListener('change', (event) => {
    addFiles(event.target.files);
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

  $('#memory-import-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      try {
        await importMemory(file);
      } catch (err) {
        toast(err.message || '导入记忆失败', 'error');
      }
    }
  });

  $('#composer')?.addEventListener('focus', () => {
    state.stickToBottom = true;
  });

  /* 设置面板 */
  $('#model-picker-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (button && !button.disabled) selectModel(button.dataset.model);
  });

  $('#effort-slider')?.addEventListener('input', (event) => {
    const steps = effortSteps(currentModel());
    const step = steps[Number(event.target.value)];
    if (!step) return;
    if (step.value === 'none') updateSetting({ thinking: false, reasoning_effort: 'none' });
    else updateSetting({ thinking: true, reasoning_effort: step.value });
  });

  $('#thinking-switch')?.addEventListener('click', () => {
    const meta = currentModel();
    if (meta?.thinking.mode === 'always') {
      toast('该模型始终开启思考');
      return;
    }
    updateSetting({ thinking: !state.settings.thinking });
  });
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
    const max = currentModel()?.maxOutput || 393_216;
    const value = Math.min(max, Math.max(1, Math.round(Number(event.target.value) || 65_536)));
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
      'toggle-theme': () => {
        cycleTheme();
        closeMore();
      },
      'toggle-more': (event) => toggleMore(event),
      'toggle-model-picker': (event) => toggleModelPicker(event),
      'close-model-picker': () => closeModelPicker(),
      'scroll-bottom': () => {
        state.stickToBottom = true;
        scrollToBottom(true);
      },
      attach: () => $('#file-input')?.click(),
      'toggle-thinking': () => {
        const meta = currentModel();
        if (meta?.thinking.mode === 'always') {
          toast('该模型始终开启思考');
          return;
        }
        updateSetting({ thinking: !state.settings.thinking });
      },
      'toggle-web': () => {
        const meta = currentModel();
        if (!meta?.capabilities.webTools) {
          toast('当前模型不支持 DeepSeek 联网工具');
          return;
        }
        const next = !state.settings.web_search;
        updateSetting({ web_search: next, read_url: next });
      },
      'export-md': () => exportConversation('md'),
      'export-json': () => exportConversation('json'),
      'export-memory': () => exportMemory(),
      import: () => $('#import-input')?.click(),
      'import-memory': () => $('#memory-import-input')?.click(),
      'remember-conversation': () => rememberConversation(),
      'read-url': () => openReadUrl(),
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
      continue: () => sendMessage({ continuing: true }),
      branch: () => switchBranch(actionEl.closest('.msg')?.dataset.msgId, Number(actionEl.dataset.dir || 0)),
      'edit-message': () => editMessage(actionEl.dataset.id),
      'read-aloud': () => {
        const message = findMessage(actionEl.dataset.id);
        readAloud(message?.content || '');
      },
      voice: () => startVoiceInput(),
      'remove-image': () => {
        state.draftImages = state.draftImages.filter((image) => image.id !== actionEl.dataset.img);
        renderAttachments();
      },
      'remove-file': () => {
        state.draftFiles = state.draftFiles.filter((file) => file.id !== actionEl.dataset.file);
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
  if (!event.target.closest('#model-popover') && !event.target.closest('#model-picker-btn')) {
    closeModelPicker();
  }
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
