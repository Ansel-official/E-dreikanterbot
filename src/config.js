import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureDirSync } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
export const KIMI_MODELS = [
  'kimi-k3.1-pro',
  'kimi-k3.1-pro-highspeed',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
];
export const MODELS = [...DEEPSEEK_MODELS, ...KIMI_MODELS];
export const EFFORTS = ['none', 'low', 'high', 'max'];

export const DEFAULT_SYSTEM_PROMPT = [
  '你是 E-dreikanterbot，一个运行在用户自己的服务器上、由 DeepSeek API 驱动的 AI 助手。',
  '回答要准确、直接、有条理；不确定时明确说明，不要编造事实、数据或链接。',
  '使用用户所用的语言回答。代码放进带语言标识的 Markdown 代码块。',
  '你可以调用 remember_fact 记住用户的长期偏好与稳定事实，调用 recall_memory 回忆已保存的信息。',
  '只在信息具有长期价值时调用 remember_fact；寒暄、一次性任务和可从对话中直接看到的内容不要写入记忆。',
].join('\n');

export function parseDotEnv(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value === '\\n') value = '\n';
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseDotEnv(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function readOrCreateSecret(dataDir) {
  const file = path.join(dataDir, 'secret.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 首次启动 */
  }
  ensureDirSync(dataDir);
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides = {}) {
  loadDotEnv(path.join(ROOT, '.env'));

  const dataDir = path.resolve(ROOT, text(process.env.DATA_DIR, './data'));
  ensureDirSync(dataDir);

  const accessToken = text(process.env.ACCESS_TOKEN);
  const sessionSecret = text(process.env.SESSION_SECRET) || readOrCreateSecret(dataDir);

  const cfg = {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    dataDir,
    conversationsDir: path.join(dataDir, 'conversations'),
    filesDir: path.join(dataDir, 'files'),
    memoryFile: path.join(dataDir, 'memory.json'),

    env: text(process.env.NODE_ENV, 'development'),
    timezone: text(process.env.TIMEZONE, 'Asia/Shanghai'),
    host: text(process.env.HOST, '0.0.0.0'),
    port: int(process.env.PORT, 8788),
    trustProxy: int(process.env.TRUST_PROXY, 0),

    apiKey: text(process.env.DEEPSEEK_API_KEY),
    baseUrl: text(process.env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com').replace(/\/+$/, ''),
    kimiApiKey: text(process.env.KIMI_API_KEY) || text(process.env.MOONSHOT_API_KEY),
    kimiBaseUrl: text(process.env.KIMI_BASE_URL, 'https://api.moonshot.cn/v1').replace(/\/+$/, ''),
    defaultModel: MODELS.includes(text(process.env.DEFAULT_MODEL)) ? text(process.env.DEFAULT_MODEL) : MODELS[0],

    accessToken,
    sessionSecret,

    systemPrompt: text(process.env.SYSTEM_PROMPT) || DEFAULT_SYSTEM_PROMPT,

    memory: {
      enabled: bool(process.env.MEMORY_ENABLED, true),
      topK: int(process.env.MEMORY_TOP_K, 8),
      maxChars: int(process.env.MEMORY_MAX_CHARS, 4000),
    },
    context: {
      maxTokens: int(process.env.MAX_CONTEXT_TOKENS, 900000),
      maxMessages: int(process.env.MAX_HISTORY_MESSAGES, 400),
    },
    generation: {
      thinking: bool(process.env.DEFAULT_THINKING, true),
      reasoningEffort: EFFORTS.includes(text(process.env.DEFAULT_REASONING_EFFORT))
        ? text(process.env.DEFAULT_REASONING_EFFORT)
        : 'high',
      maxTokens: int(process.env.DEFAULT_MAX_TOKENS, 65536),
      temperature: Number(process.env.DEFAULT_TEMPERATURE ?? 1),
      topP: Number(process.env.DEFAULT_TOP_P ?? 0.95),
    },
    safetyLevel: text(process.env.SAFETY_LEVEL, 'high') === 'low' ? 'low' : 'high',
    titleEnabled: bool(process.env.TITLE_ENABLED, true),
    webToolsEnabled: bool(process.env.WEB_TOOLS_ENABLED, false),

    corsOrigin: text(process.env.CORS_ORIGIN, '*'),
    rateLimit: {
      chat: Math.max(1, int(process.env.RATE_LIMIT_CHAT, 30)),
      api: Math.max(1, int(process.env.RATE_LIMIT_API, 300)),
    },
    maxBodyBytes: Math.max(64 * 1024, int(process.env.MAX_BODY_BYTES, 48 * 1024 * 1024)),

    site: {
      name: text(process.env.SITE_NAME, 'E-dreikanterbot'),
      url: text(process.env.SITE_URL),
      contactEmail: text(process.env.CONTACT_EMAIL),
      icpNumber: text(process.env.ICP_NUMBER),
      icpLink: text(process.env.ICP_LINK, 'https://beian.miit.gov.cn/'),
      policeNumber: text(process.env.POLICE_NUMBER),
      policeLink: text(process.env.POLICE_LINK, 'https://beian.mps.gov.cn/'),
    },

    upstreamTimeoutMs: Math.max(5000, int(process.env.UPSTREAM_TIMEOUT_MS, 10 * 60 * 1000)),
    maxToolRounds: 3,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && cfg[key] && typeof cfg[key] === 'object') {
      cfg[key] = { ...cfg[key], ...value };
    } else {
      cfg[key] = value;
    }
  }
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.conversationsDir = path.join(cfg.dataDir, 'conversations');
  cfg.filesDir = path.join(cfg.dataDir, 'files');
  cfg.memoryFile = path.join(cfg.dataDir, 'memory.json');
  ensureDirSync(cfg.conversationsDir);
  ensureDirSync(cfg.filesDir);
  return cfg;
}

/** 只暴露给浏览器的安全字段，绝不包含 apiKey / sessionSecret / accessToken。 */
export function publicConfig(cfg, catalog = null) {
  const models = catalog?.models || [];
  const providers = catalog?.providers || [];
  const configured = new Set(providers.filter((provider) => provider.configured).map((provider) => provider.id));
  const defaultModel =
    models.find((model) => model.id === cfg.defaultModel && configured.has(model.provider))?.id ||
    models.find((model) => configured.has(model.provider))?.id ||
    cfg.defaultModel;

  return {
    site: cfg.site,
    version: '1.1.0',
    providers,
    models,
    defaultModel,
    defaults: {
      thinking: cfg.generation.thinking,
      reasoningEffort: cfg.generation.reasoningEffort,
      maxTokens: cfg.generation.maxTokens,
      temperature: cfg.generation.temperature,
      topP: cfg.generation.topP,
      safetyLevel: cfg.safetyLevel,
      webTools: cfg.webToolsEnabled,
      title: cfg.titleEnabled,
      memory: cfg.memory.enabled,
    },
    limits: {
      maxTokens: Math.max(393_216, ...models.map((model) => Number(model.maxOutput) || 0)),
      minTokens: 1,
      maxContextTokens: Math.max(cfg.context.maxTokens, ...models.map((model) => Number(model.contextWindow) || 0)),
      maxBodyBytes: cfg.maxBodyBytes,
      maxImages: 4,
      maxImageBytes: 8 * 1024 * 1024,
    },
    features: {
      memory: cfg.memory.enabled,
      vision: true,
      webTools: true,
      title: cfg.titleEnabled,
      api: true,
      login: Boolean(cfg.accessToken),
      keyConfigured: Boolean(cfg.apiKey || cfg.kimiApiKey),
      deepseekConfigured: Boolean(cfg.apiKey),
      kimiConfigured: Boolean(cfg.kimiApiKey),
    },
    warnings: catalog?.warnings || [],
  };
}
