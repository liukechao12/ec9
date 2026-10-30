# EC9 HTTPS 证书与 Nginx 运维手册

> 上线时间：2026-10-30 18:00
> 服务器：root@39.107.42.137（阿里云 · Alibaba Cloud Linux 4）
> 域名：ec9.51world.com.cn（A 记录 → 39.107.42.137）

---

## 一、当前架构

```
用户 ──HTTPS(443)──▶ Nginx ──HTTP──▶ Node(127.0.0.1:3000) ──▶ PostgreSQL(127.0.0.1:5432)
       HTTP(80) 301 跳转      （HTTPS 由 Nginx 终结，Node 只处理明文）
```

- **证书**：Let's Encrypt 免费 DV 证书，由 acme.sh 签发，有效期 90 天，**全自动续期**
- **HTTPS 终结在 Nginx**，Node 不再直接对外，只监听 `127.0.0.1:3000`
- `app.set('trust proxy', 1)` 已开 → `req.ip` 取 `X-Forwarded-For` 真实 IP

## 二、关键路径

| 用途 | 路径 |
|---|---|
| 站点配置 | `/etc/nginx/conf.d/ec9.conf` |
| Nginx 主配置 | `/etc/nginx/nginx.conf`（默认 server 已挪到 8081 让出 80） |
| 证书文件 | `/etc/nginx/ssl/ec9.crt`（fullchain）、`/etc/nginx/ssl/ec9.key` |
| acme.sh | `/root/.acme.sh/acme.sh`（域名目录 `/root/.acme.sh/ec9.51world.com.cn/`） |
| ACME 校验目录 | `/var/www/html/.well-known/acme-challenge/`（80 端口**不跳转**，续期靠它） |
| 后端 .env | `/opt/ec9/backend/.env`（`PORT=3000` `HOST=127.0.0.1` `FRONTEND_URL=https://ec9.51world.com.cn`） |
| 配置备份 | `/opt/ec9/backend/.env.bak.ssl.*`、`/etc/nginx/nginx.conf.bak.ssl` |

## 三、证书信息

```
subject = CN = ec9.51world.com.cn
issuer  = C=US, O=Let's Encrypt, CN=YR1
签发    = 2026-10-30 09:03 GMT
到期    = 2027-01-28 09:03 GMT   （90 天）
协议    = TLS 1.2 / TLS 1.3，关闭 TLS 1.0/1.1 与会话票据
```

**续期机制**：acme.sh 安装时已写入 crontab，每天 03:19 / 09:19 / 15:19 / 21:19 检查：

```
19 3,9,15,21 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null
```

到期前 30 天内才会真正续期；续完自动 `--install-cert` 覆盖 `/etc/nginx/ssl/` 并 `systemctl reload nginx`，**不中断服务**。
（`crond` 已确认 enabled + running；2026-10-30 已做过一次 `--renew --force` 演练，链路验证通过。）

## 四、常用命令

```bash
# 查看续期计划与证书列表
/root/.acme.sh/acme.sh --list

# 手动强制续期（演练或排查用）
/root/.acme.sh/acme.sh --renew -d ec9.51world.com.cn --force

# 检查配置语法 / 重载
nginx -t && systemctl reload nginx

# 证书到期时间
openssl x509 -in /etc/nginx/ssl/ec9.crt -noout -dates

# 握手与证书链校验（应 Verify return code: 0 (ok)）
echo | openssl s_client -connect 127.0.0.1:443 -servername ec9.51world.com.cn 2>/dev/null | grep -E "Verify|Protocol|Cipher"

# 重启后端（铁律：每次更新部署程序后必做）
cd /opt/ec9/backend && pm2 restart ec9-backend --update-env
```

## 五、注意事项（改之前必读）

1. **80 端口的 `/.well-known/acme-challenge/` 绝不能跳转**，否则 90 天后续期失败。
2. 改 Nginx 配置 → `nginx -t` 通过后再 `systemctl reload nginx`（不要 restart，避免中断）。
3. **Node 端口改回 80 会让 Nginx 起不来**（80 被占）。要回退：把 `.env` 的 `PORT/HOST` 改回 `80 / 0.0.0.0` 并停掉 Nginx。
4. 新增域名：先加 A 记录 → `acme.sh --issue -d 新域名 --webroot /var/www/html` → 在 `ec9.conf` 里加 `server_name` → reload。
5. 阿里云**安全组必须放行 443**（本次已确认外网可通，无需改动）；本机 `firewalld` 是 disabled 状态。
6. 已发出的旧短信/票链接是 `http://39.107.42.137/...`，会被 301 跳到 `https://ec9.51world.com.cn/...`，**功能不受影响**。
7. `FRONTEND_URL` 已从 `http://39.107.42.137` 改成 `https://ec9.51world.com.cn`，短信付款链接、电子票链接都基于它生成；改这个值需要 `pm2 restart --update-env`。

## 六、可选增强（未启用，需确认后再动）

- **HSTS**：`add_header Strict-Transport-Security "max-age=31536000" always;`
  ⚠️ 一旦下发，浏览器一年内强制 HTTPS，无法回退 HTTP。
- **OCSP Stapling**：需配 `resolver` 且服务器能连外网 DNS。
- **HTTP/2**：已通过 `http2 on;` 启用。
