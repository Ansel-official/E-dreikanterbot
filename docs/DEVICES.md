# 设备适配说明

目标：同一套零构建前端，在桌面浏览器、平板、手机、PWA 独立窗口中都能正常使用。

---

## 1. 布局断点

| 断点 | 布局 |
| --- | --- |
| ≥ 1081px | 侧栏 288px，对话区最大 860px，右侧抽屉 430px |
| 901–1080px | 侧栏 260px |
| 561–900px | 侧栏变为左侧抽屉，顶栏出现汉堡菜单；模型胶囊仍显示 |
| ≤ 560px | 单列、隐藏主题按钮与模型胶囊、输入区紧凑、建议卡片单列 |

尺寸单位使用 `dvh`，配合 `viewport-fit=cover`，避免移动端浏览器地址栏导致的底部遮挡。

## 2. 安全区

- 顶栏：`padding-top: env(safe-area-inset-top)`
- 输入区与页脚：`padding-bottom: env(safe-area-inset-bottom)`
- 抽屉：同样处理上下安全区

适配 iPhone 刘海/灵动岛与底部手势条。

## 3. 触控与可读性

- 主要按钮 ≥ 32×32px；发送键 38×38px。
- 字号：正文 14.5–15px，移动端 14.5px，行高 1.6–1.72。
- 支持 `prefers-reduced-motion`，关闭动画。
- 使用 `-webkit-text-size-adjust` 默认行为，不锁定缩放。
- 代码块横向滚动，表格 `overflow-x: auto`，不撑破页面。
- 输入框随内容自动增高（上限 208px），`Enter` 发送、`Shift+Enter` 换行；中文输入法组合态不会误发送。

## 4. PWA

`public/manifest.webmanifest` + `public/sw.js`：

- 可安装（standalone），图标 192/512/maskable，iOS `apple-touch-icon`。
- Service Worker：
  - 导航请求：网络优先，离线回退缓存首页。
  - 静态资源：stale-while-revalidate。
  - `/api/*`、`/v1/*` 永不缓存。
- 离线只能打开界面，不能对话（需要网络与 API Key）。

### 安装方式

- **Android Chrome**：菜单 →「安装应用」/「添加到主屏幕」。
- **iOS Safari**：分享 →「添加到主屏幕」。
- **桌面 Chrome/Edge**：地址栏安装图标，或「更多」菜单里的「安装到本机」（本项目也提供入口）。

## 5. 自检不同视口

启动演示模式：

```bash
node demo/dev.js
```

打开：

```text
http://127.0.0.1:8789/preview.html?device=desktop
http://127.0.0.1:8789/preview.html?device=tablet
http://127.0.0.1:8789/preview.html?device=mobile
http://127.0.0.1:8789/preview.html?device=small
```

预览页用同源 iframe 模拟 1180×820、820×1000、390×844、360×780。

> 生产模式默认发送 `X-Frame-Options: DENY` 与 `frame-ancestors 'none'`，只有 `demo`/`test` 环境允许同源 iframe，避免点击劫持。

## 6. 键盘

| 快捷键 | 行为 |
| --- | --- |
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `Ctrl/⌘ + K` | 新对话 |
| `Esc` | 停止生成 / 关闭面板 |

## 7. 已知限制

- 不是原生 App；推送通知、后台常驻、系统分享等能力受 PWA 限制。
- iOS PWA 的存储可能被系统回收，重要会话请定期导出/备份。
- 不支持 IE；需要支持 ES Modules、`fetch`、`ReadableStream` 的现代浏览器。
- 图片在客户端压缩到最长边 1600px，GIF 保留原图（可能较大）。
- 未实现语音输入/朗读（官方 ASR/TTS 在路线图中）。

## 8. 性能

- 零运行时依赖、零构建；首屏只加载 `index.html + styles.css + app.js + markdown.js`。
- 流式渲染节流 55ms，避免每个 token 重排整页。
- 历史消息按需渲染（当前会话），长会话仍建议定期新开。
- 静态资源带 ETag 与 gzip；带版本号的资源可长缓存。
