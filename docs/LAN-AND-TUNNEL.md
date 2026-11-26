# 手机访问 / 公网访问（内网穿透）

> 两个 chatbot 都是「前端 + 后端」结构，**不能纯静态托管**：网页能传上去，但没有后端转发，
> 一发消息就 404。所以手机上用只有两条路：同一 Wi-Fi 的局域网，或者内网穿透。

---

## 一、局域网（最快，0 成本）

1. 电脑和手机连**同一个 Wi-Fi**；
2. 双击 `start-lan.bat`；
3. 脚本会打印两个地址，并把手机那个**复制到剪贴板**：

```
Local : http://localhost:8788
Phone : http://192.168.1.10:8788
```

4. 手机浏览器打开 `Phone` 那行 → 菜单「添加到桌面」→ 桌面出现图标。

### 打不开？先看防火墙

Windows 默认拦外部入站。管理员 PowerShell 跑一次（永久生效）：

```powershell
netsh advfirewall firewall add rule name="E-dreikanterbot" dir=in action=allow protocol=TCP localport=8788
netsh advfirewall firewall add rule name="chat-demo"        dir=in action=allow protocol=TCP localport=8090
```

其它排查顺序：

| 现象 | 原因 | 处理 |
|---|---|---|
| 手机能 ping 通但打不开 | 防火墙 | 上面那条规则 |
| 电脑能开、手机不行 | 服务只监听 127.0.0.1 | 设 `HOST=0.0.0.0` 再启动 |
| 突然连不上 | 路由器给电脑换了 IP | 路由器里给电脑绑定固定 IP（DHCP 保留） |
| 公司/校园网 | 启用了 AP 隔离 | 换热点或走公网隧道 |

---

## 二、公网（在外面也能用）

### 方式 A：cloudflared 快速隧道（免费、不用账号）

```powershell
start-lan.bat --public
```

脚本会另开一个窗口跑：

```
cloudflared tunnel --url http://localhost:8788
```

窗口里会出现一行：

```
https://random-words-1234.trycloudflare.com
```

这就是公网地址，手机用 4G 也能打开。**关掉窗口隧道就断了**，地址每次随机。

特点：
- 不需要域名、不需要备案、不需要注册；
- 带宽和稳定性一般，适合临时演示、自己用；
- 走 Cloudflare 边缘，国内多数网络能访问。

### 方式 B：固定地址（要长期用再考虑）

| 方案 | 成本 | 说明 |
|---|---|---|
| cloudflared 命名隧道 | 免费 + 一个自己的域名 | `cloudflared tunnel create` 登录 Cloudflare，绑定子域名，地址固定 |
| frp / 花生壳 | 免费额度有限 | 需要一台有公网 IP 的服务器做中转 |
| 云服务器直接部署 | 60–100 元/年 | 最稳，但要自己做备份和安全 |

⚠️ 用**自己的域名 + 境内服务器**对外提供访问，就要走 ICP 备案（见 `docs/ICP.md`）；
用 `trycloudflare.com` 这种第三方域名则不需要。

---

## 三、三个项目的端口

| 项目 | 端口 | 启动 |
|---|---|---|
| E-dreikanterbot | 8788 | `node server.js`（或 `start-lan.bat`） |
| chat-demo | 8090（前端）/ 8809（网关） | `npm start`（或 `start-lan.bat`） |
| Dreikanter photo | 任意静态端口，或直接用 GitHub Pages | 见项目 README |

---

## 四、安全提醒

- 局域网模式下，同 Wi-Fi 的**任何人**都能打开你的服务。公用网络别这么做。
- 公网隧道等于把服务暴露到互联网。E-dreikanterbot 没有登录体系，
  **别人拿到 URL 就能用你的 API Key 烧额度**。临时用完记得关窗口。
- 真要长期暴露，给服务加一层 Basic Auth 或改用带账号体系的那一版（Dreikanterbot）。
