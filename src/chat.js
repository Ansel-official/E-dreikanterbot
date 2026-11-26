import { EFFORTS, MODELS } from './config.js';
import { buildApiMessages, canPassTools } from './context.js';
import { streamChatCompletion as defaultStream } from './deepseek.js';
import { estimateCost } from './pricing.js';
import { clampNumber, isAbortError, newId, oneLine, truncate } from './util.js';

export const MAX_OUTPUT_TOKENS = 393216;

export const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        '把用户的长期稳定信息写入长期记忆库，例如身份、偏好、项目背景、明确要求记住的规则。一次只写一条，简短、自包含、第三人称。不要写入寒暄、一次性任务或对话中一眼可见的内容。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一条自包含的事实，例如「用户偏好用中文回答，代码示例使用 TypeScript」。' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，例如 偏好、项目、身份。' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '按关键词检索长期记忆库。当用户提到「之前说过」「还记得吗」，或需要历史偏好、项目背景时调用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词或短句' } },
        required: ['query'],
      },
    },
  },
];

const WEB_TOOLS = [
  { type: 'deepseek_web_search', name: 'deepseek_web_search' },
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
];

function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  };
}

function mergeUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return;
  const hit = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const prompt = Number(usage.prompt_tokens) || 0;
  const miss = Number(usage.prompt_cache_miss_tokens) || Math.max(0, prompt - hit);
  total.prompt_tokens += prompt;
  total.completion_tokens += Number(usage.completion_tokens) || 0;
  total.total_tokens += Number(usage.total_tokens) || prompt + (Number(usage.completion_tokens) || 0);
  total.prompt_cache_hit_tokens += hit;
  total.prompt_cache_miss_tokens += miss;
}

function sanitizeUserId(value) {
  const clean = String(value || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
  return clean || `edb_${newId('u').slice(2, 12)}`;
}

function mergeToolCalls(map, deltas) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : map.size;
    const current = map.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
    map.set(index, current);
  }
}

export class ChatService {
  constructor({ cfg, conversations, memory, stream = defaultStream }) {
    this.cfg = cfg;
    this.conversations = conversations;
    this.memory = memory;
    this.stream = stream;
  }

  normalizeSettings(raw = {}) {
    const cfg = this.cfg;
    let thinking = raw.thinking === undefined ? cfg.generation.thinking : Boolean(raw.thinking);
    let effort = EFFORTS.includes(raw.reasoning_effort) ? raw.reasoning_effort : cfg.generation.reasoningEffort;
    if (raw.reasoning_effort === 'none') thinking = false;
    if (!thinking) effort = 'none';
    else if (effort === 'none') effort = 'high';

    const stopList = Array.isArray(raw.stop)
      ? raw.stop
      : typeof raw.stop === 'string'
        ? raw.stop.split(/\r?\n/)
        : [];
    const stop = stopList
      .map((s) => String(s).trim())
      .filter(Boolean)
      .filter((s) => Buffer.byteLength(s, 'utf8') <= 512)
      .slice(0, 16);

    const safety = raw.safety_check && typeof raw.safety_check === 'object' ? raw.safety_check.level : raw.safety_check;

    return {
      model: MODELS.includes(raw.model) ? raw.model : cfg.defaultModel,
      thinking,
      reasoningEffort: effort,
      maxTokens: Math.round(clampNumber(raw.max_tokens, 1, MAX_OUTPUT_TOKENS, cfg.generation.maxTokens)),
      temperature: clampNumber(raw.temperature, 0, 2, cfg.generation.temperature),
      topP: clampNumber(raw.top_p, 0, 1, cfg.generation.topP),
      stop,
      jsonMode: Boolean(raw.json_mode),
      webSearch: raw.web_search === undefined ? cfg.webToolsEnabled : Boolean(raw.web_search),
      readUrl: raw.read_url === undefined ? cfg.webToolsEnabled : Boolean(raw.read_url),
      memory: raw.memory === undefined ? cfg.memory.enabled : Boolean(raw.memory),
      title: raw.title === undefined ? cfg.titleEnabled : Boolean(raw.title),
      safetyLevel: safety === 'high' || safety === 'low' ? safety : cfg.safetyLevel,
      userId: sanitizeUserId(raw.user_id),
    };
  }

  buildPayload({ settings, messages, tools }) {
    const payload = {
      model: settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
      max_tokens: settings.maxTokens,
      user_id: settings.userId,
    };
    if (settings.thinking) payload.reasoning_effort = settings.reasoningEffort;
    if (!settings.thinking) {
      payload.temperature = settings.temperature;
      payload.top_p = settings.topP;
    }
    if (settings.stop.length) payload.stop = settings.stop;
    if (settings.jsonMode) payload.response_format = { type: 'json_object' };
    if (settings.safetyLevel === 'high') payload.safety_check = { level: 'high' };
    if (tools.length) payload.tools = tools;
    return payload;
  }

  /**
   * 执行一轮对话（可能包含多次工具调用），通过 emit 推送 SSE 事件。
   * @param {(event:string, data:object)=>void} emit
   */
  async run({ conversation, settings, signal, emit, attachmentResolver }) {
    const startedAt = Date.now();
    const requestId = newId('req');
    const canUseMemoryTools = this.cfg.memory.enabled && settings.memory;
    const toolsEnabled = canUseMemoryTools && canPassTools(conversation);

    const lastUser = [...conversation.messages].reverse().find((m) => m.role === 'user');
    const query = typeof lastUser?.content === 'string' ? lastUser.content : '';

    let memoryBlock = '';
    let memoryFacts = [];
    if (this.cfg.memory.enabled && settings.memory) {
      const block = this.memory.buildBlock({
        query,
        topK: this.cfg.memory.topK,
        maxChars: this.cfg.memory.maxChars,
      });
      memoryBlock = block.text;
      memoryFacts = block.facts.map((f) => ({ id: f.id, text: f.text }));
      if (block.text) emit('memory', { count: block.facts.length, facts: memoryFacts });
    }

    const built = await buildApiMessages({
      cfg: this.cfg,
      conversation,
      memoryBlock,
      includeTools: toolsEnabled,
      budgetTokens: this.cfg.context.maxTokens,
      maxMessages: this.cfg.context.maxMessages,
      reserveOutput: settings.maxTokens,
      attachmentResolver,
    });

    const tools = [];
    if (toolsEnabled) tools.push(...MEMORY_TOOLS);
    if (settings.webSearch) tools.push(...WEB_TOOLS);

    emit('meta', {
      requestId,
      conversationId: conversation.id,
      model: settings.model,
      thinking: settings.thinking,
      reasoningEffort: settings.reasoningEffort,
      maxTokens: settings.maxTokens,
      tools: tools.map((t) => t.name || t.function?.name),
      estimatedTokens: built.estimatedTokens,
      trimmed: built.trimmed,
      budget: built.budget,
    });
    if (built.trimmed > 0) {
      emit('notice', { level: 'info', message: `上下文较长，已省略较早的 ${built.trimmed} 条消息` });
    }
    if (canUseMemoryTools && !toolsEnabled) {
      emit('notice', { level: 'info', message: '历史中存在缺少思考内容的助手消息，本轮暂不启用记忆工具（记忆仍会注入）' });
    }

    let messages = built.messages;
    let allContent = '';
    let allReasoning = '';
    let finishReason = 'stop';
    let title = '';
    let annotations = [];
    let serverToolCalls = [];
    let usage = emptyUsage();
    let aborted = false;
    let rounds = 0;

    while (rounds <= this.cfg.maxToolRounds) {
      const payload = this.buildPayload({ settings, messages, tools });
      if (this.cfg.titleEnabled && settings.title && !conversation.titleLocked && rounds === 0) {
        payload.title = { enabled: true };
      }

      let round;
      try {
        round = await this.streamRound({ payload, signal, emit, settings });
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          aborted = true;
          finishReason = 'aborted';
          break;
        }
        if (allContent || allReasoning) {
          await this.persistAssistant(conversation, {
            content: allContent,
            reasoning: allReasoning,
            thinking: settings.thinking,
            error: err.message,
            usage,
            model: settings.model,
          });
        }
        throw err;
      }

      mergeUsage(usage, round.usage);
      if (round.title) title = round.title;
      if (round.annotations.length) annotations = round.annotations;
      if (round.serverToolCalls.length) serverToolCalls = round.serverToolCalls;
      if (round.content) allContent += round.content;
      if (round.reasoning) allReasoning += round.reasoning;
      finishReason = round.finishReason || finishReason;

      const calls = round.toolCalls.filter((call) => call.function?.name);
      if (!calls.length) break;

      if (rounds >= this.cfg.maxToolRounds) {
        emit('notice', { level: 'warning', message: `已达到工具调用轮数上限（${this.cfg.maxToolRounds}）` });
        break;
      }

      // 官方要求：带 tools 时，助手消息必须回传 reasoning_content 与 tool_calls
      const assistantTurn = {
        role: 'assistant',
        content: round.content || '',
        tool_calls: calls,
      };
      if (settings.thinking) assistantTurn.reasoning_content = round.reasoning || '';
      messages = [...messages, assistantTurn];

      const executed = [];
      for (const call of calls) {
        const result = this.executeTool(call);
        executed.push({ call, result });
        emit('tool', {
          id: call.id,
          name: call.function.name,
          status: result.ok === false ? 'error' : 'done',
          summary: result.summary || '',
          args: safeArgs(call.function.arguments),
          result: sanitizeToolResult(result),
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.data || result),
        });
      }

      // 中间轮次持久化（UI 隐藏），保证后续请求里的 tool 消息成对出现
      await this.conversations.append(conversation.id, {
        role: 'assistant',
        content: round.content || '',
        reasoning: round.reasoning || '',
        thinking: settings.thinking,
        toolCalls: calls,
        hidden: true,
      });
      for (const { call, result } of executed) {
        await this.conversations.append(conversation.id, {
          role: 'tool',
          toolCallId: call.id,
          toolName: call.function.name,
          content: JSON.stringify(result.data || result),
          hidden: true,
        });
      }

      rounds += 1;
    }

    const cost = estimateCost(settings.model, usage);
    const usageRecord = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cached_tokens: usage.prompt_cache_hit_tokens,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
      cost: cost.total,
    };

    const finalMessage = await this.persistAssistant(conversation, {
      content: allContent,
      reasoning: allReasoning,
      thinking: settings.thinking,
      aborted,
      usage: usageRecord,
      model: settings.model,
      serverToolCalls,
      annotations,
    });

    if (title && this.cfg.titleEnabled && settings.title && !conversation.titleLocked) {
      const clean = oneLine(title, 80);
      if (clean) {
        await this.conversations.update(conversation.id, { title: clean, titleLocked: false });
        emit('title', { title: clean });
      }
    }

    emit('usage', { ...usageRecord, cost: cost.total, costDetail: cost, elapsedMs: Date.now() - startedAt });
    emit('done', {
      messageId: finalMessage?.id,
      finishReason,
      aborted,
      elapsedMs: Date.now() - startedAt,
      rounds,
      title,
    });

    return { message: finalMessage, usage: usageRecord, cost, finishReason, aborted, title };
  }

  async streamRound({ payload, signal, emit, settings }) {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage = null;
    let title = '';
    const annotations = [];
    const serverToolCalls = [];
    const toolCalls = new Map();

    for await (const chunk of this.stream(payload, {
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
      signal,
      timeoutMs: this.cfg.upstreamTimeoutMs,
    })) {
      if (chunk.usage) usage = chunk.usage;
      if (typeof chunk.title === 'string') title = chunk.title;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (typeof choice.title === 'string') title = choice.title;
      if (typeof choice.message?.title === 'string') title = choice.message.title;

      const delta = choice.delta || choice.message || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        emit('reasoning', { delta: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        emit('content', { delta: delta.content });
      }
      if (delta.tool_calls) mergeToolCalls(toolCalls, delta.tool_calls);
      if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
      if (Array.isArray(delta.server_tool_calls)) serverToolCalls.push(...delta.server_tool_calls);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    // 兼容：部分字段只在整轮的 message 里出现
    const calls = [...toolCalls.values()].map((call, index) => ({
      ...call,
      id: call.id || `call_${Date.now()}_${index}`,
    }));

    return { content, reasoning, toolCalls: calls, usage, finishReason, title, annotations, serverToolCalls };
  }

  executeTool(call) {
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { ok: false, error: '工具参数不是合法 JSON', summary: '工具参数解析失败', data: { ok: false, error: 'invalid_json' } };
    }

    const name = call.function.name;
    if (name === 'remember_fact') {
      const text = String(args.text || '').trim();
      if (!text) {
        return { ok: false, error: 'text 不能为空', summary: '记忆内容为空', data: { ok: false, error: 'empty_text' } };
      }
      try {
        const fact = this.memory.add({ text, tags: args.tags, source: 'model' });
        const summary = fact.duplicate ? `记忆中已有：${truncate(text, 40)}` : `已记住：${truncate(text, 40)}`;
        return {
          ok: true,
          summary,
          data: { ok: true, id: fact.id, duplicate: Boolean(fact.duplicate), saved: fact.text },
        };
      } catch (err) {
        return { ok: false, error: err.message, summary: `记忆写入失败：${err.message}`, data: { ok: false, error: err.message } };
      }
    }

    if (name === 'recall_memory') {
      const items = this.memory.recall(String(args.query || ''), 6);
      return {
        ok: true,
        summary: `检索到 ${items.length} 条相关记忆`,
        data: { ok: true, count: items.length, items },
      };
    }

    return { ok: false, error: `未知工具：${name}`, summary: `未知工具 ${name}`, data: { ok: false, error: 'unknown_tool' } };
  }

  async persistAssistant(conversation, data) {
    return this.conversations.append(conversation.id, {
      role: 'assistant',
      content: data.content || '',
      reasoning: data.reasoning || '',
      thinking: Boolean(data.thinking),
      usage: data.usage,
      model: data.model,
      aborted: Boolean(data.aborted),
      error: data.error || undefined,
      serverToolCalls: data.serverToolCalls?.length ? data.serverToolCalls : undefined,
      annotations: data.annotations?.length ? data.annotations : undefined,
    });
  }
}

function safeArgs(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? truncate(v, 200) : v]));
  } catch {
    return {};
  }
}

function sanitizeToolResult(result) {
  const data = result.data || {};
  if (data.items) {
    return { ok: true, count: data.count, items: data.items.map((i) => ({ text: i.text, tags: i.tags })) };
  }
  return data;
}
