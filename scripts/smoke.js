#!/usr/bin/env node
/**
 * 真实链路自测：直接调用 DeepSeek / Kimi 官方 API。
 *   node scripts/smoke.js                               # 默认模型
 *   node scripts/smoke.js deepseek-flash "你好"
 *   node scripts/smoke.js kimi-k3.1-pro "你好"
 * 会产生极少量费用（默认 max_tokens 256）。
 */
import { loadConfig } from '../src/config.js';
import { streamChatCompletion } from '../src/deepseek.js';
import { estimateCost } from '../src/pricing.js';
import { ModelRegistry } from '../src/providers.js';

const cfg = loadConfig();
const registry = new ModelRegistry(cfg);
await registry.init();

const modelId = process.argv[2] || registry.effectiveDefaultModel();
const prompt = process.argv[3] || '用一句话介绍你自己，并说出 1+1 等于几。';
const resolved = registry.resolve(modelId);

if (!resolved) {
  console.error(`不支持的模型：${modelId}`);
  console.error('可选：', registry.models.map((model) => model.id).join(' / '));
  process.exit(1);
}

const { provider, meta } = resolved;
const apiKey = registry.apiKeyFor(provider);
if (!apiKey) {
  console.error(`${meta.providerName} 未配置 API Key，请在 .env 中填写。`);
  process.exit(1);
}

const payload = {
  model: meta.id,
  messages: [{ role: 'user', content: prompt }],
  stream: true,
  stream_options: { include_usage: true },
};

if (provider === 'kimi') {
  payload.max_completion_tokens = Number(process.env.SMOKE_MAX_TOKENS || 256);
  if (meta.thinking.mode === 'always') payload.reasoning_effort = 'low';
  else if (meta.thinking.mode === 'optional') payload.thinking = { type: 'enabled', keep: 'all' };
} else {
  payload.max_tokens = Number(process.env.SMOKE_MAX_TOKENS || 256);
  payload.thinking = { type: 'enabled' };
  payload.reasoning_effort = 'low';
  payload.safety_check = { level: cfg.safetyLevel };
}

console.log(`\nProvider：${meta.providerName}\n模型：${meta.id}\n问题：${prompt}\n`);

const started = Date.now();
let reasoning = '';
let content = '';
let usage = null;
let finish = '';

try {
  for await (const chunk of streamChatCompletion(payload, {
    apiKey,
    baseUrl: registry.baseUrlFor(provider),
    timeoutMs: 180_000,
  })) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    if (choice.delta?.reasoning_content) {
      reasoning += choice.delta.reasoning_content;
      process.stdout.write(`\x1b[2m${choice.delta.reasoning_content}\x1b[0m`);
    }
    if (choice.delta?.content) {
      content += choice.delta.content;
      process.stdout.write(choice.delta.content);
    }
  }
} catch (err) {
  console.error(`\n\n调用失败（HTTP ${err.status || '?'}）：${err.message}`);
  if (err.hint) console.error(`提示：${err.hint}`);
  process.exit(2);
}

console.log('\n');
console.log(`耗时      ${((Date.now() - started) / 1000).toFixed(2)}s`);
console.log(`结束原因  ${finish || '未知'}`);
console.log(`思考字符  ${reasoning.length}`);
console.log(`回答字符  ${content.length}`);
if (usage) {
  const cost = estimateCost(meta.id, usage, meta);
  console.log(
    `用量      prompt=${usage.prompt_tokens}（缓存命中 ${usage.prompt_cache_hit_tokens || 0} / 写入 ${usage.prompt_tokens_details?.cache_write_tokens || 0}） completion=${usage.completion_tokens} total=${usage.total_tokens}`,
  );
  if (cost) {
    console.log(`估算费用  $${cost.total.toFixed(6)}（${cost.tier === 'peak' ? '高峰' : '低峰'}价，仅供参考）`);
  } else {
    console.log('估算费用  Kimi 以 Moonshot 控制台账单为准');
  }
}
console.log('\n✓ 链路正常\n');
