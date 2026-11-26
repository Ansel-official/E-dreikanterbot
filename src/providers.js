import { listModels } from './deepseek.js';

/**
 * 多 Provider 模型注册表。
 * - DeepSeek：模型元数据以官方 GET /models 为准，失败时回退到文档内置值。
 * - Kimi：模型能力/上下文档位来自官方文档；/models 只用于发现当前可用 ID。
 */

export const PROVIDER_DEFS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    docs: 'https://api-docs.deepseek.com/',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyHint: '在 .env 设置 DEEPSEEK_API_KEY',
    accent: '#4d6bfe',
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    docs: 'https://platform.kimi.com/docs/',
    keyEnv: 'KIMI_API_KEY',
    altKeyEnv: 'MOONSHOT_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    keyHint: '在 .env 设置 KIMI_API_KEY（Moonshot 开放平台）',
    accent: '#111111',
  },
};

const DEEPSEEK_PRESETS = [
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    name: 'DeepSeek V4.1 Flash',
    description: '快速、支持视觉，适合日常对话与图片理解',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    defaultOutput: 65_536,
    inputModalities: ['text', 'image'],
    thinking: { mode: 'toggle', efforts: ['low', 'high', 'max'], defaultEffort: 'high', defaultEnabled: true },
    capabilities: { vision: true, tools: true, webTools: true, title: true, safetyCheck: true, cache: 'prefix' },
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    name: 'DeepSeek V4 Pro',
    description: '更强推理，文本专用，适合复杂任务',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    defaultOutput: 65_536,
    inputModalities: ['text'],
    thinking: { mode: 'toggle', efforts: ['low', 'high', 'max'], defaultEffort: 'high', defaultEnabled: true },
    capabilities: { vision: false, tools: true, webTools: true, title: true, safetyCheck: true, cache: 'prefix' },
  },
];

const KIMI_PRESETS = [
  {
    id: 'kimi-k3.1-pro',
    provider: 'kimi',
    name: 'Kimi K3.1 Pro',
    description: 'Kimi 旗舰，1M 上下文，原生视觉，始终深度思考',
    contextWindow: 1_048_576,
    maxOutput: 1_048_576,
    defaultOutput: 131_072,
    inputModalities: ['text', 'image', 'video'],
    thinking: { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort: 'max', defaultEnabled: true },
    capabilities: { vision: true, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
  },
  {
    id: 'kimi-k3.1-pro-highspeed',
    provider: 'kimi',
    name: 'Kimi K3.1 Pro 高速版',
    description: 'K3.1 Pro 的 2–3 倍速度版本',
    contextWindow: 1_048_576,
    maxOutput: 1_048_576,
    defaultOutput: 131_072,
    inputModalities: ['text', 'image', 'video'],
    thinking: { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort: 'max', defaultEnabled: true },
    capabilities: { vision: true, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
  },
  {
    id: 'kimi-k3',
    provider: 'kimi',
    name: 'Kimi K3',
    description: '上一代旗舰，1M 上下文，原生视觉',
    contextWindow: 1_048_576,
    maxOutput: 1_048_576,
    defaultOutput: 131_072,
    inputModalities: ['text', 'image', 'video'],
    thinking: { mode: 'always', efforts: ['low', 'high', 'max'], defaultEffort: 'max', defaultEnabled: true },
    capabilities: { vision: true, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
  },
  {
    id: 'kimi-k2.7-code',
    provider: 'kimi',
    name: 'Kimi K2.7 Code',
    description: '代码专用，始终思考；已对新人停止开放',
    contextWindow: 262_144,
    maxOutput: 262_144,
    defaultOutput: 32_768,
    inputModalities: ['text'],
    thinking: { mode: 'always', efforts: [], defaultEffort: null, defaultEnabled: true },
    capabilities: { vision: false, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
    deprecated: true,
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    provider: 'kimi',
    name: 'Kimi K2.7 Code 高速版',
    description: '代码专用高速版；已对新人停止开放',
    contextWindow: 262_144,
    maxOutput: 262_144,
    defaultOutput: 32_768,
    inputModalities: ['text'],
    thinking: { mode: 'always', efforts: [], defaultEffort: null, defaultEnabled: true },
    capabilities: { vision: false, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
    deprecated: true,
  },
  {
    id: 'kimi-k2.6',
    provider: 'kimi',
    name: 'Kimi K2.6',
    description: '可关闭思考；已对新人停止开放',
    contextWindow: 262_144,
    maxOutput: 262_144,
    defaultOutput: 32_768,
    inputModalities: ['text'],
    thinking: { mode: 'optional', efforts: [], defaultEffort: null, defaultEnabled: true },
    capabilities: { vision: false, tools: true, webTools: false, title: false, safetyCheck: false, cache: 'prefix' },
    deprecated: true,
  },
];

function cloneModel(model, extra = {}) {
  return {
    ...model,
    inputModalities: [...model.inputModalities],
    thinking: { ...model.thinking, efforts: [...model.thinking.efforts] },
    capabilities: { ...model.capabilities },
    ...extra,
  };
}

function genericModel(providerId, item) {
  const kimi = providerId === 'kimi';
  return {
    id: item.id,
    provider: providerId,
    name: item.name || item.id,
    description: '通过官方 /models 自动发现',
    contextWindow: Number(item.context_window || item.context_length) || (kimi ? 1_048_576 : 1_048_576),
    maxOutput: Number(item.max_output_tokens) || (kimi ? 1_048_576 : 393_216),
    defaultOutput: kimi ? 131_072 : 65_536,
    inputModalities: Array.isArray(item.input_modalities) && item.input_modalities.length ? [...item.input_modalities] : ['text'],
    thinking: {
      mode: kimi ? 'always' : 'toggle',
      efforts: kimi ? ['low', 'high', 'max'] : ['low', 'high', 'max'],
      defaultEffort: kimi ? 'max' : 'high',
      defaultEnabled: true,
    },
    capabilities: {
      vision: Array.isArray(item.input_modalities) && item.input_modalities.includes('image'),
      tools: true,
      webTools: !kimi,
      title: !kimi,
      safetyCheck: !kimi,
      cache: 'prefix',
    },
  };
}

function mergeDynamic(def, item, preset) {
  const base = preset ? cloneModel(preset) : genericModel(def.id, item);
  const efforts = item?.effort?.supported_levels || item?.reasoning_efforts?.valid_efforts;
  const modalities = item?.input_modalities || item?.modalities?.input;
  const imageIn = item?.supports_image_in;
  const videoIn = item?.supports_video_in;
  const contextWindow = Number(item?.context_window || item?.context_length) || base.contextWindow;
  const maxOutput = Number(item?.max_output_tokens) || base.maxOutput;
  const thinkingMode =
    item?.supports_thinking_type === 'only'
      ? 'always'
      : item?.supports_thinking_type === 'optional'
        ? 'optional'
        : base.thinking.mode;

  const inputModalities = Array.isArray(modalities) && modalities.length ? [...modalities] : [...base.inputModalities];
  if (imageIn && !inputModalities.includes('image')) inputModalities.push('image');
  if (videoIn && !inputModalities.includes('video')) inputModalities.push('video');
  if (!imageIn && imageIn !== undefined) {
    const idx = inputModalities.indexOf('image');
    if (idx >= 0) inputModalities.splice(idx, 1);
  }

  return {
    ...base,
    name: item?.name || base.name,
    contextWindow,
    maxOutput,
    inputModalities,
    thinking: {
      ...base.thinking,
      mode: thinkingMode,
      ...(Array.isArray(efforts) && efforts.length
        ? { efforts: efforts.filter((level) => ['low', 'high', 'max'].includes(level)) }
        : {}),
      ...(item?.effort?.default_level || item?.reasoning_efforts?.default_effort
        ? { defaultEffort: item.effort?.default_level || item.reasoning_efforts?.default_effort }
        : {}),
    },
    capabilities: {
      ...base.capabilities,
      vision: inputModalities.includes('image'),
    },
  };
}

export class ModelRegistry {
  constructor(cfg) {
    this.cfg = cfg;
    this.fetchedAt = 0;
    this.models = [];
    this.providers = [];
    this.warnings = [];
  }

  providerDef(id) {
    return PROVIDER_DEFS[id] || null;
  }

  apiKeyFor(providerId) {
    if (providerId === 'deepseek') return this.cfg.apiKey || '';
    if (providerId === 'kimi') return this.cfg.kimiApiKey || process.env.MOONSHOT_API_KEY || '';
    return '';
  }

  baseUrlFor(providerId) {
    if (providerId === 'deepseek') return this.cfg.baseUrl || PROVIDER_DEFS.deepseek.defaultBaseUrl;
    if (providerId === 'kimi') return this.cfg.kimiBaseUrl || PROVIDER_DEFS.kimi.defaultBaseUrl;
    return '';
  }

  isConfigured(providerId) {
    return Boolean(this.apiKeyFor(providerId));
  }

  presetsFor(providerId) {
    return providerId === 'deepseek' ? DEEPSEEK_PRESETS : KIMI_PRESETS;
  }

  async init() {
    await this.refresh(true);
  }

  async refresh(force = false) {
    const fresh = this.models.length && Date.now() - this.fetchedAt < 5 * 60 * 1000;
    if (!force && fresh) return this.snapshot();
    const warnings = [];

    const results = await Promise.all(
      Object.values(PROVIDER_DEFS).map(async (def) => {
        const key = this.apiKeyFor(def.id);
        const presets = this.presetsFor(def.id);
        if (!key) {
          return {
            def,
            configured: false,
            error: null,
            models: presets.map((model) => cloneModel(model)),
          };
        }
        try {
          const response = await listModels({
            apiKey: key,
            baseUrl: this.baseUrlFor(def.id),
            timeoutMs: 15_000,
          });
          const items = Array.isArray(response?.data) ? response.data.filter((item) => item?.id) : [];
          if (!items.length) throw new Error('官方 /models 返回空列表');
          const models = items.map((item) => {
            const preset = presets.find((candidate) => candidate.id === item.id);
            return mergeDynamic(def, item, preset);
          });
          return { def, configured: true, error: null, models };
        } catch (err) {
          warnings.push(`${def.name} 模型列表获取失败：${err.message}`);
          return {
            def,
            configured: true,
            error: err.message,
            models: presets.map((model) => cloneModel(model)),
          };
        }
      }),
    );

    this.providers = results.map(({ def, configured, error, models }) => ({
      id: def.id,
      name: def.name,
      docs: def.docs,
      accent: def.accent,
      configured,
      error,
      keyHint: configured ? '' : def.keyHint,
      models: models.map((model) => model.id),
    }));

    this.models = results.flatMap(({ models }) =>
      models.map((model) => ({ ...model, providerName: PROVIDER_DEFS[model.provider]?.name || model.provider })),
    );
    this.warnings = warnings;
    this.fetchedAt = Date.now();
    return this.snapshot();
  }

  async snapshot() {
    if (!this.models.length) await this.refresh(true);
    return {
      providers: this.providers,
      models: this.models,
      warnings: this.warnings,
      fetchedAt: new Date(this.fetchedAt).toISOString(),
    };
  }

  effectiveDefaultModel() {
    const wanted = this.models.find((model) => model.id === this.cfg.defaultModel);
    if (wanted && this.isConfigured(wanted.provider)) return wanted.id;
    const configured = this.models.find((model) => this.isConfigured(model.provider));
    return configured?.id || wanted?.id || this.cfg.defaultModel;
  }

  resolve(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let id = raw;
    let providerHint = null;
    if (raw.includes('/')) {
      const [prefix, ...rest] = raw.split('/');
      if (PROVIDER_DEFS[prefix]) {
        providerHint = prefix;
        id = rest.join('/');
      }
    }
    const meta = this.models.find(
      (model) => model.id === id && (!providerHint || model.provider === providerHint),
    );
    if (!meta) return null;
    return { provider: meta.provider, meta, requested: raw };
  }
}
