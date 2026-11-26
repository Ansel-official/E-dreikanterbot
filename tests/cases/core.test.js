import { assert, equal, includes, matches, test } from '../lib.js';
import { RateLimiter } from '../../src/app.js';
import { parseDotEnv } from '../../src/config.js';
import { buildApiMessages, canPassTools, dateLine, estimateTokens } from '../../src/context.js';
import { parseSSE } from '../../src/deepseek.js';
import { estimateCost, isPeak, pricesFor } from '../../src/pricing.js';
import { signSession, verifySession } from '../../src/util.js';

export default function register() {
  test('token 估算：中文密度高于英文', async () => {
    equal(estimateTokens(''), 0);
    const cjk = estimateTokens('中文'.repeat(50));
    const ascii = estimateTokens('a'.repeat(50));
    assert(cjk > ascii, `中文 ${cjk} 应大于英文 ${ascii}`);
    assert(estimateTokens('hello world') > 0);
  });

  test('日期提示：包含日期与时区', async () => {
    const line = dateLine(new Date('2026-11-26T10:00:00Z'), 'Asia/Shanghai');
    includes(line, '2026-11-26');
    includes(line, 'Asia/Shanghai');
    includes(line, '星期四');
  });

  test('.env 解析：引号、注释、等号', async () => {
    const parsed = parseDotEnv(
      ['# comment', 'A=1', 'B="hello world"', "C='x=y'", 'D=', 'EMPTY=', 'Q="a\\n"'].join('\n'),
    );
    equal(parsed.A, '1');
    equal(parsed.B, 'hello world');
    equal(parsed.C, 'x=y');
    equal(parsed.D, '');
    equal(parsed.EMPTY, '');
  });

  test('SSE 解析：跨块、CRLF、多行 data、注释', async () => {
    async function* source() {
      yield 'data: {"a":';
      yield '1}\r\n\r\ndata: line1\ndata: line2\n\n: keep-alive\n\n';
      yield 'event: custom\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    }
    const events = [];
    for await (const event of parseSSE(source())) events.push(event);
    equal(events.length, 4);
    equal(events[0].data, '{"a":1}');
    equal(events[1].data, 'line1\nline2');
    equal(events[2].event, 'custom');
    equal(events[2].data, '{"b":2}');
    equal(events[3].data, '[DONE]');
  });

  test('高峰/低峰计价与费用估算', async () => {
    const peak = new Date('2026-11-26T02:30:00Z'); // 周四 02:30 UTC
    const offpeak = new Date('2026-11-26T05:30:00Z');
    const weekend = new Date('2026-11-28T02:30:00Z');
    assert(isPeak(peak), '周四 02:30 应为高峰');
    assert(!isPeak(offpeak), '05:30 应为低峰');
    assert(!isPeak(weekend), '周六应为低峰');

    equal(pricesFor('deepseek-flash', peak).cacheMiss, 0.3);
    equal(pricesFor('deepseek-flash', offpeak).cacheMiss, 0.15);

    const full = estimateCost(
      'deepseek-flash',
      { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 },
      peak,
    );
    equal(full.inputCost, 0.306);
    equal(full.outputCost, 1.2);
    equal(full.total, 1.506);
    equal(full.cacheSaved, 0.294);
  });

  test('会话签名可验证，篡改后失效', async () => {
    const secret = 's'.repeat(32);
    const token = 'access-token';
    const session = signSession(secret, token, 60_000);
    assert(verifySession(session, secret, token), '签名应通过');
    assert(!verifySession(session, secret, 'other'), '换 token 应失败');
    assert(!verifySession(session, `${secret}x`, token), '换 secret 应失败');
    assert(!verifySession(`${session}x`, secret, token), '篡改应失败');
    assert(!verifySession(signSession(secret, token, -1000), secret, token), '过期应失败');
  });

  test('限流器：窗口内计数与 retryAfter', async () => {
    const limiter = new RateLimiter();
    assert(limiter.hit('k', 2).ok);
    assert(limiter.hit('k', 2).ok);
    const third = limiter.hit('k', 2);
    assert(!third.ok);
    assert(third.retryAfter >= 1);
    assert(limiter.hit('other', 1).ok);
  });

  test('上下文构建：单 system、按预算裁剪、保留最后一条', async () => {
    const cfg = { systemPrompt: '你是测试助手。', timezone: 'UTC' };
    const history = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${i} ` + 'x'.repeat(200),
    }));
    const built = await buildApiMessages({
      cfg,
      conversation: { messages: history },
      budgetTokens: 1200,
      maxMessages: 400,
      reserveOutput: 1,
    });
    equal(built.messages[0].role, 'system');
    equal(built.messages.filter((m) => m.role === 'system').length, 1);
    assert(built.trimmed > 0, '应当发生裁剪');
    includes(built.messages[0].content, '已省略较早的');
    equal(built.messages.at(-1).content, history.at(-1).content);
    assert(built.estimatedTokens <= 30_000);
  });

  test('上下文构建：记忆块与附件内容数组', async () => {
    const cfg = { systemPrompt: 'SYS', timezone: 'UTC' };
    const built = await buildApiMessages({
      cfg,
      conversation: {
        messages: [
          { role: 'user', content: '看图', attachments: [{ file: 'a.png', mime: 'image/png' }] },
          { role: 'assistant', content: '好的', reasoning: '思考', thinking: true },
        ],
      },
      memoryBlock: '<memory>\n- 用户喜欢深色模式\n</memory>',
      includeTools: true,
      attachmentResolver: async () => 'data:image/png;base64,AAAA',
    });
    includes(built.messages[0].content, '<memory>');
    const user = built.messages.find((m) => m.role === 'user');
    assert(Array.isArray(user.content), '带图片的用户消息应为内容数组');
    assert(user.content.some((part) => part.type === 'image_url'), '应包含 image_url 片段');
    const assistant = built.messages.find((m) => m.role === 'assistant');
    equal(assistant.reasoning_content, '思考');
  });

  test('canPassTools：仅缺少思考内容且标记 thinking 时阻断', async () => {
    assert(canPassTools({ messages: [{ role: 'assistant', content: 'a', thinking: true, reasoning: 'r' }] }));
    assert(!canPassTools({ messages: [{ role: 'assistant', content: 'a', thinking: true }] }));
    assert(canPassTools({ messages: [{ role: 'assistant', content: 'a', thinking: false }] }));
    assert(canPassTools({ messages: [{ role: 'assistant', content: 'a' }] }));
  });

  test('工具调用参数校验：非法 JSON 被安全丢弃', async () => {
    const { ChatService } = await import('../../src/chat.js');
    const service = new ChatService({ cfg: { memory: { enabled: true }, maxToolRounds: 3 }, conversations: {}, memory: {} });
    const result = service.executeTool({ function: { name: 'remember_fact', arguments: '{bad json' } });
    equal(result.ok, false);
    includes(result.error, 'JSON');
  });
}
