# EdgePay Docker watcher

公开镜像：

```text
ghcr.io/suk-ldev/edgepay-watcher:latest
```

支持 `linux/amd64` 与 `linux/arm64`，内置 Node.js 24、Playwright Chromium、License
验签和统一监听插件。完整在线教程：<https://deploy.imsuk.cn/guide.html>。

## 获取 License

1. 打开 <https://license.imsuk.cn>；
2. 输入支付 Worker 的正式域名；
3. 免费插件默认包含，付费插件按需选择，也可以全部不选；
4. 保存生成的永久 License；
5. Worker Secret 和容器 `EDGEPAY_LICENSE` 填写同一 License。

一个 License 最多绑定一个活动 watcher 实例。

## 启动

```bash
cp .env.example .env
mkdir -p storage
chmod 700 storage
chmod 600 .env
```

编辑 `.env`：

```dotenv
WORKER_URL=https://pay.example.com
TRANSPORT_KEY=部署完成页的-WATCHER_TRANSPORT_SECRET
EDGEPAY_LICENSE=从-license.imsuk.cn-生成的-EPL1-License
POLL_SECONDS=15
MAX_CONCURRENCY=2
WATCHER_STORAGE_DIR=/app/var/storage
```

启动并查看日志：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

## 更新

```bash
docker compose pull
docker compose up -d
```

## 排错

- License 错误：核对 `WORKER_URL`、Worker `PUBLIC_BASE_URL` 与 License 域名。
- HMAC/签名错误：核对 `TRANSPORT_KEY` 与 Worker Secret `WATCHER_TRANSPORT_SECRET`。
- 浏览器插件启动失败：保留至少 512 MiB 可用内存和 256 MiB `/dev/shm`。
- 日志：`docker compose logs --tail=200 payment-watcher`。
