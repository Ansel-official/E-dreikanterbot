# 部署指南

支持 Linux / macOS / Windows，最低 Node.js 20。运行时零依赖，不需要构建。

---

## 1. 单机部署（systemd）

```bash
# 1) 放置代码
sudo mkdir -p /opt/e-dreikanterbot
sudo chown "$USER" /opt/e-dreikanterbot
git clone https://github.com/Ansel-official/E-dreikanterbot.git /opt/e-dreikanterbot
cd /opt/e-dreikanterbot

# 2) 配置
cp .env.example .env
chmod 600 .env
# 编辑 .env：DEEPSEEK_API_KEY、ACCESS_TOKEN、SITE_URL、ICP_NUMBER…

# 3) 预检
node scripts/check.js

# 4) 试运行
node server.js
```

访问 `http://服务器IP:8788`，确认无误后交给 systemd：

```ini
# /etc/systemd/system/e-dreikanterbot.service
[Unit]
Description=E-dreikanterbot
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/e-dreikanterbot
EnvironmentFile=/opt/e-dreikanterbot/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/e-dreikanterbot/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now e-dreikanterbot
sudo systemctl status e-dreikanterbot
```

> `data/` 必须可写；`ProtectSystem=full` 下只有 `ReadWritePaths` 允许写入。

---

## 2. Nginx 反向代理（SSE 关键配置）

```nginx
server {
    listen 80;
    server_name chat.example.com;

    client_max_body_size 48m;   # 与 MAX_BODY_BYTES 保持一致

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 必配
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        add_header X-Accel-Buffering no;
    }
}
```

对应 `.env`：

```dotenv
TRUST_PROXY=1
```

否则限流与 Cookie 的 Secure 判断拿不到真实 IP / 协议。

### HTTPS

用 certbot：

```bash
sudo certbot --nginx -d chat.example.com
```

或 Caddy（自动 HTTPS，SSE 默认支持）：

```caddyfile
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8788 {
        flush_interval -1
    }
}
```

> 开启 HTTPS 后，`Secure` Cookie 会自动生效（依赖 `X-Forwarded-Proto`）。

---

## 3. Docker

```bash
cp .env.example .env
# 填 DEEPSEEK_API_KEY、ACCESS_TOKEN

docker compose up -d --build
docker compose logs -f
```

`docker-compose.yml` 会把 `./data` 挂载到容器内，升级不丢会话与记忆。

单独构建：

```bash
docker build -t e-dreikanterbot .
docker run -d --name edb \
  --env-file .env \
  -p 8788:8788 \
  -v "$PWD/data:/app/data" \
  --restart unless-stopped \
  e-dreikanterbot
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8788/api/health
```

---

## 4. 备份与升级

```bash
# 备份
tar -czf edb-backup-$(date +%F).tgz data/

# 升级
cd /opt/e-dreikanterbot
git pull
sudo systemctl restart e-dreikanterbot
```

`data/` 是唯一需要保留的目录；`.env` 请单独备份。

---

## 5. 公网部署安全清单

- [ ] 设置强随机 `ACCESS_TOKEN`（≥ 24 字符）
- [ ] 启用 HTTPS，HTTP 301 跳转
- [ ] `SAFETY_LEVEL=high`
- [ ] 配置 `ICP_NUMBER`、`POLICE_NUMBER`（如适用）
- [ ] `TRUST_PROXY=1`（在反向代理后）
- [ ] 限制 `RATE_LIMIT_CHAT` / `RATE_LIMIT_API`
- [ ] 不把 `.env`、`data/` 提交到 Git
- [ ] 定期备份 `data/`
- [ ] 关注 [DeepSeek API 状态](https://status.deepseek.com/)
- [ ] 阅读并落实 [docs/ICP.md](ICP.md) 中的备案与内容安全义务

---

## 6. 常见问题

**启动报 EADDRINUSE**
换 `PORT`，或结束占用进程。

**流式回答被 Nginx 一次性吐出**
检查 `proxy_buffering off`、`X-Accel-Buffering: no`、`proxy_read_timeout`。

**登录后立刻掉线**
通常是 `TRUST_PROXY` 未设置导致 Secure Cookie 判断异常，或反向代理没有透传 `X-Forwarded-Proto`。

**上传图片 413**
调大 `MAX_BODY_BYTES` 与 Nginx `client_max_body_size`；前端会把大图压到 1600px。

**余额查询失败**
`/user/balance` 需要有效 API Key；不影响对话。
