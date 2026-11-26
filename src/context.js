const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 轻量 token 估算（不引入 tokenizer 依赖）：
 * 中文约 0.62 token/字，其他字符约 0.28 token/字符。
 * 只用于上下文裁剪与 UI 预估，真实用量以 API 返回的 usage 为准。
 */
export function estimateTokens(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (CJK_RE.test(ch)) cjk += 1;
  const other = text.length - cjk;
  return Math.ceil(cjk * 0.62 + other * 0.28);
}

export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text') total += estimateTokens(part.text);
    else if (part.type === 'image_url' || part.type === 'file') total += 1024;
  }
  return total;
}

export function estimateMessageTokens(message) {
  let total = 4;
  total += estimateContentTokens(message.content);
  if (message.reasoning_content) total += estimateTokens(message.reasoning_content);
  if (message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls));
  return total;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function dateLine(now = new Date(), timezone = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const weekdayIndex = new Date(`${parts}T00:00:00Z`).getUTCDay();
    return `当前日期：${parts}（${WEEKDAYS[weekdayIndex]}，时区 ${timezone}）。用户主要使用简体中文。`;
  } catch {
    return `当前日期：${now.toISOString().slice(0, 10)}。`;
  }
}

/**
 * 把本地会话转换成官方 Chat Completions 的 messages。
 * - 单条 system：人设 + 记忆块 + 日期，前缀稳定以命中上下文缓存
 * - 按预算从最旧开始裁剪，并保留最后一条
 * - 仅在有工具时回传 reasoning_content / tool_calls（官方要求）
 */
export async function buildApiMessages({
  cfg,
  conversation,
  memoryBlock = '',
  includeTools = false,
  includeReasoning = includeTools,
  provider = 'deepseek',
  budgetTokens = 900_000,
  contextWindow = 1_000_000,
  maxMessages = 400,
  reserveOutput = 65_536,
  attachmentResolver = null,
  now = new Date(),
}) {
  const systemParts = [cfg.systemPrompt];
  if (provider === 'kimi') {
    systemParts.push(
      '当前会话由 Kimi（Moonshot）API 提供，不是 DeepSeek。不要声称自己是 DeepSeek 或使用 DeepSeek 的自称。',
    );
  }
  if (memoryBlock) systemParts.push(memoryBlock);
  systemParts.push(dateLine(now, cfg.timezone || 'Asia/Shanghai'));

  let history = conversation?.messages ? [...conversation.messages] : [];
  if (maxMessages > 0 && history.length > maxMessages) history = history.slice(-maxMessages);

  const entries = [];
  for (const msg of history) {
    const entry = await toApiMessage(msg, { includeTools, includeReasoning, attachmentResolver });
    if (!entry) continue;
    entries.push({ entry, tokens: estimateMessageTokens(entry) });
  }

  const budget = Math.max(2_000, Math.min(budgetTokens, contextWindow - reserveOutput - 2_048));
  const kept = [];
  let used = 0;
  let trimmed = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i];
    if (kept.length && used + item.tokens > budget) {
      trimmed = i + 1;
      break;
    }
    kept.push(item);
    used += item.tokens;
  }
  kept.reverse();

  const notice =
    trimmed > 0
      ? `\n\n（上下文提示：为控制长度，已省略较早的 ${trimmed} 条消息。若用户追问已省略的内容，请让用户重新提供。）`
      : '';
  const systemContent = `${systemParts.join('\n\n')}${notice}`;

  return {
    messages: [{ role: 'system', content: systemContent }, ...kept.map((item) => item.entry)],
    trimmed,
    estimatedTokens: used + estimateTokens(systemContent),
    budget,
  };
}

async function toApiMessage(msg, { includeTools, includeReasoning, attachmentResolver }) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.role === 'user') {
    const fileBlock = (msg.files || [])
      .filter((file) => file && typeof file.text === 'string' && file.text.trim())
      .map(
        (file) =>
          `\n\n<file name="${String(file.name || 'attachment').slice(0, 80)}">\n${String(file.text).slice(0, 200_000)}\n</file>`,
      )
      .join('');
    const contentText = `${msg.content || ''}${fileBlock}`;

    if (msg.attachments?.length && attachmentResolver) {
      const parts = [];
      if (contentText) parts.push({ type: 'text', text: contentText });
      for (const attachment of msg.attachments) {
        const url = await attachmentResolver(attachment);
        if (url) parts.push({ type: 'image_url', image_url: { url, detail: 'high' } });
      }
      if (!parts.length) return null;
      return { role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts };
    }
    if (!contentText) return null;
    return { role: 'user', content: contentText };
  }

  if (msg.role === 'assistant') {
    if (!msg.content && !msg.reasoning && !msg.toolCalls?.length) return null;
    const entry = { role: 'assistant', content: msg.content || '' };
    // DeepSeek 仅在有 tools 时要求回传思考内容；Kimi K3 系列始终要求保留式思考。
    if (includeReasoning || (includeTools && msg.thinking)) {
      entry.reasoning_content = msg.reasoning || '';
    }
    if (includeTools && msg.toolCalls?.length) entry.tool_calls = msg.toolCalls;
    if (msg.serverToolCalls?.length) entry.server_tool_calls = msg.serverToolCalls;
    if (msg.annotations?.length) entry.annotations = msg.annotations;
    return entry;
  }

  if (msg.role === 'tool') {
    if (!includeTools || !msg.toolCallId) return null;
    return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content || '' };
  }

  if (msg.role === 'system') {
    if (!msg.content) return null;
    return { role: 'system', content: msg.content };
  }

  return null;
}

/**
 * 判断历史是否满足「带 tools 时必须回传全部 reasoning_content」的要求。
 * 只有明确在思考模式下产生、却缺失 reasoning 的助手消息才会阻断。
 */
export function canPassTools(conversation) {
  const messages = conversation?.messages || [];
  return messages.every((msg) => {
    if (msg.role !== 'assistant') return true;
    if (!msg.thinking) return true;
    return typeof msg.reasoning === 'string';
  });
}
