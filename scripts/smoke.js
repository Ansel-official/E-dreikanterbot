#!/usr/bin/env node
/**
 * 真实链路自测：直接调用 DeepSeek 官方 API，验证密钥、流式、思考模式和用量统计。
 * 会产生极少费用（默认 max_tokens 256）。
 *   node scripts/smoke.js
 */
import { loadConfig } from '../src/config.js';
import { streamChatCompletion } from '../src/deepseek.js';
import { estimateCost } from '../src/pricing.js';

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error('未配置 DEEPSEEK_API_KEY，请先填写 .env。');
  process.exit(1);
}

const model = process.argv[2] || cfg.defaultModel;
const prompt = process.argv[3] || '用一句话介绍你自己，并说出 1+1 等于几。';
console.log(`\n模型：${model}\n问题：${prompt}\n`);

const started = Date.now();
let reasoning = '';
let content = '';
let usage = null;
let finish = '';

try {
  for await (const chunk of streamChatCompletion(
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      max_tokens: Number(process.env.SMOKE_MAX_TOKENS || 256),
      safety_check: { level: cfg.safetyLevel },
    },
    { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeoutMs: 120_000 },
  )) {
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
  const cost = estimateCost(model, usage);
  console.log(
    `用量      prompt=${usage.prompt_tokens}（缓存命中 ${usage.prompt_cache_hit_tokens || 0}） completion=${usage.completion_tokens} total=${usage.total_tokens}`,
  );
  console.log(`估算费用  $${cost.total.toFixed(6)}（${cost.tier === 'peak' ? '高峰' : '低峰'}价，仅供参考）`);
}
console.log('\n✓ 链路正常\n');
