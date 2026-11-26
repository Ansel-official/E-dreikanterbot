/**
 * 官方计价（美元 / 1M tokens），来源：
 * https://api-docs.deepseek.com/quick_start/pricing
 *
 * 高峰时段：UTC 周一至周五 01:00–04:00、06:00–10:00；
 * 其余时间（含周末与法定节假日）为低峰，价格为高峰的一半。
 * 节假日无法在本地可靠判定，因此这里只按 UTC 工作日计算，并在 UI 标注「估算」。
 */
export const PRICING = {
  'deepseek-flash': {
    cacheHit: { peak: 0.006, offpeak: 0.003 },
    cacheMiss: { peak: 0.3, offpeak: 0.15 },
    output: { peak: 1.2, offpeak: 0.6 },
  },
  'deepseek-v4-pro': {
    cacheHit: { peak: 0.044, offpeak: 0.022 },
    cacheMiss: { peak: 1.32, offpeak: 0.66 },
    output: { peak: 3.96, offpeak: 1.98 },
  },
};

export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';

export function isPeak(date = new Date()) {
  const day = date.getUTCDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function pricesFor(model, date = new Date()) {
  const table = PRICING[model] || PRICING['deepseek-flash'];
  const tier = isPeak(date) ? 'peak' : 'offpeak';
  return {
    tier,
    cacheHit: table.cacheHit[tier],
    cacheMiss: table.cacheMiss[tier],
    output: table.output[tier],
  };
}

/**
 * @param {string} model
 * @param {{prompt_cache_hit_tokens?:number, prompt_cache_miss_tokens?:number, prompt_tokens?:number, completion_tokens?:number}} usage
 * @param {{provider?:string}|Date} [metaOrDate]
 */
export function estimateCost(model, usage = {}, metaOrDate = null) {
  const meta = metaOrDate instanceof Date ? null : metaOrDate;
  const date = metaOrDate instanceof Date ? metaOrDate : meta?.date || new Date();
  // Kimi 的计价表按官方页面实时变化，本项目不硬编码 CN¥ 价格，
  // 只返回 token 用量，避免给出错误的费用估算。
  if (meta?.provider === 'kimi' || String(model).startsWith('kimi-')) return null;
  const table = PRICING[model];
  if (!table) return null;
  const p = pricesFor(model, date);
  const hit = Math.max(0, Number(usage.prompt_cache_hit_tokens) || 0);
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const miss = Math.max(0, Number(usage.prompt_cache_miss_tokens) || Math.max(0, prompt - hit));
  const out = Math.max(0, Number(usage.completion_tokens) || 0);

  const inputCost = (hit * p.cacheHit + miss * p.cacheMiss) / 1e6;
  const outputCost = (out * p.output) / 1e6;
  const saved = (hit * (p.cacheMiss - p.cacheHit)) / 1e6;

  return {
    currency: 'USD',
    tier: p.tier,
    inputCost: round6(inputCost),
    outputCost: round6(outputCost),
    total: round6(inputCost + outputCost),
    cacheSaved: round6(saved),
    tokens: { hit, miss, output: out },
    prices: p,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
