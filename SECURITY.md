# 安全说明

## 支持范围

| 版本 | 支持 |
| --- | --- |
| 1.x | 是 |

## 报告漏洞

请通过 GitHub 仓库的 **Security → Report a vulnerability** 私密报告，不要公开 Issue 中贴出可利用细节、API Key 或用户数据。

我们会尽快确认；修复前请给维护者合理的处理时间。

---

## 威胁模型

本项目定位是**单实例、少量可信用户**的聊天机器人：

- `ACCESS_TOKEN` 是共享访问密码，不是多用户账号体系。
- 任何持有该密码的人都能读取/删除该实例的全部会话与记忆。
- 如需多租户隔离，请为每个用户/团队部署独立实例，或在外层增加身份网关。

服务端持有 `DEEPSEEK_API_KEY`，浏览器永远拿不到它。

---

## 已实现的安全措施

| 面 | 措施 |
| --- | --- |
| 密钥 | 只在服务端 `.env`；`/api/config` 白名单字段，绝不下发 |
| 登录 | 常量时间比较；HMAC-SHA256 签名 Cookie；HttpOnly + SameSite=Lax；HTTPS 下 Secure |
| CSRF | 所有写操作要求 `X-Requested-With: E-dreikanterbot`，且 `/api` 不开放 CORS |
| 限流 | 登录 10 次/分/IP；聊天默认 30 次/分/IP；`/v1` 默认 300 次/分 |
| 请求体 | 默认 48MB 上限（与官方一致），超限直接断开 |
| 图片 | 只接受 data URL；文件头魔数校验；单张 ≤ 8MB；最多 4 张 |
| 路径穿越 | 静态与附件均做 `path.resolve` 前缀校验 / 文件名白名单 |
| XSS | 前端先转义再渲染 Markdown；链接协议白名单；不使用 `innerHTML` 插入模型原文 |
| 点击劫持 | 生产 `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| CSP | `default-src 'self'`，无外部 CDN，`object-src 'none'` |
| 依赖 | 运行时零依赖，减少供应链面 |
| 上游 | 超时、429/5xx 退避重试、4xx 不重试、客户端断开即中止 |
| 日志 | 默认只记录错误栈，不记录完整对话内容 |

---

## 部署前必做

- [ ] 设置强随机 `ACCESS_TOKEN`（≥ 24 字符，建议 32 字节随机）
- [ ] 启用 HTTPS
- [ ] `.env` 权限 600，`.gitignore` 已忽略
- [ ] 反向代理后设置 `TRUST_PROXY=1`
- [ ] `SAFETY_LEVEL=high`
- [ ] 定期备份 `data/`，并限制目录权限
- [ ] 关注依赖/上游安全公告（本项目无 npm 依赖，主要关注 Node 与 DeepSeek API）

生成随机密码：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## 已知边界

- 没有内置 WAF、验证码、账号注册、配额计费；公网大规模开放前请自行加网关。
- 提示词注入与记忆投毒无法完全避免；记忆库内容建议定期人工复核。
- 用户上传图片会存储到 `data/files/`，删除会话时一并删除；请自行制定留存策略。
- 上游返回的内容可能包含错误或不当信息，UI 已有安全提示，但仍需人工审核与投诉渠道。
- 本项目不提供任何形式的合规担保。
