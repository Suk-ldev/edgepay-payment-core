<div align="center">

# EdgePay Payment Core

可审计的 EdgePay 支付核心、免费插件、收银台与管理后台源码。

![Version](https://img.shields.io/badge/version-2.0.0-2563EB?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=000)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Tests](https://img.shields.io/badge/tests-node:test-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-16A34A?style=flat-square)](./LICENSE)

[![通过官方部署站部署](https://img.shields.io/badge/官方部署站-立即部署-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://deploy.imsuk.cn)
[![获取 License](https://img.shields.io/badge/License-获取授权-7C3AED?style=for-the-badge&logo=letsencrypt&logoColor=white)](https://license.imsuk.cn)

</div>

> [!IMPORTANT]
> 本仓库用于查看、审计和测试支付核心。它不包含付费插件、License Gate 或商业入口，
> 也没有 `export default { fetch, scheduled }` 形式的 Worker 入口，因此无法单独产出
> 可部署服务。正式部署与升级只能通过[官方部署站](https://deploy.imsuk.cn)完成。

[功能特性](#功能特性) · [技术栈](#技术栈) · [本地检查](#本地能做什么) ·
[接口说明](#epay-v1-兼容入口) · [部署](#部署) · [License](#授权)

## 为什么这样拆

付费插件（PayPal、Stripe、USDT TRC20、各收单平台等）的实现留在私有仓库，由私有 CI
编译成一个个独立模块。部署时，部署站按你的 License 权益**只挑你买过的那几个模块**
和程序本体一起上传到你自己的 Cloudflare 账户——没买的插件，代码根本不会出现在你的
Worker 里。

程序本体之所以公开，是因为它经手你的订单和商户密钥，你有理由要求看清楚它做了什么。

## 仓库里有什么

| 目录 | 内容 |
| --- | --- |
| `src/plugin-api.js` | 插件契约。付费插件在私有仓库里实现同一份契约 |
| `src/core/` | Worker 工厂、插件注册器、请求路由、通用轮询引擎 |
| `src/free-plugins/` | 6 个免费插件：微信/支付宝个人收款、支付宝官方 API、微信官方 API、收钱吧、付呗 |
| `src/` 其余 | ePay V1 接口、订单与退款、通知重试、管理认证、运行配置、D1 读写 |
| `public/` | 收银台与管理后台前端 |
| `schema.sql` | D1 表结构 |
| `tests/` | 核心合同测试（付费插件用假插件替身，不依赖私有仓库） |

## 插件契约

核心不认识任何具体插件编码。下单、支付回调、同步返回、主动查询、退款、收款码展示、
流水匹配、Worker 轮询全部通过注册表按编码取插件再调用生命周期方法：

```js
const plugin = registry.require(pluginCode);
await authorizePlugin({ plugin, operation: 'createPayment', env });
return plugin.createPayment({ config, order, env, helpers });
```

插件之间的差异靠清单声明，而不是核心里的 `if`：确认宽限期、默认订单有效期、
轮询租约与冷却、回调正文格式、回调金额是否必须严格相等等等，都是 `manifest` 字段。

改动 `plugin-api.js` 是跨仓库的 ABI 变更，必须同步抬升 `PLUGIN_API_VERSION`。

## 本地能做什么

```bash
npm ci
npm run check   # 语法检查
npm test        # 核心合同测试
```

跑得通不等于能部署——上面说过，这里没有 Worker 入口。

## 功能特性

- **ePay V1 全兼容**：页面支付、API 下单、查询、退款、异步通知签名与语义保持不变。
- **多渠道插件**：微信支付 V2（Native/H5/JSAPI/APP/小程序）、支付宝官方 API（电脑网站/
  手机网站/APP/小程序 JSAPI/订单码/当面付）、微信/支付宝个人收款、PayPal、Stripe、付呗
  码牌收款、USDT TRC20。
- **管理后台**：商户与收银台设置、插件配置、通道启停与权重路由、订单管理与手动补单、
  重新通知、退款、通道人工测试。
- **收款确认多重兜底**：官方异步回调、Worker 内置轮询、NAS Watcher、主动查询、
  手动补单，多路径通过 D1 唯一约束去重。
- **加密存储**：插件配置使用 AES-GCM 加密后存入 D1，不在环境变量中重复保存密钥。

## 技术栈

- 运行时：Cloudflare Workers（`src/`，原生 ES Modules，无框架依赖）
- 数据库：Cloudflare D1（SQLite 协议，`schema.sql` 定义表结构）
- 前端：原生 HTML/CSS/JS 资源（`public/`），发布前确定性编译到 `src/bundled-assets.js`，不创建 KV 或 `ASSETS` 绑定
- 可选组件：`agent/serverless-watcher/`，Docker 预构建镜像（`ghcr.io/suk-ldev/edgepay-watcher`，源码未开源）
- 测试：Node.js 内置 `node --test`（`tests/`）

## 目录结构

```text
.
├── src/                      # Worker 源码：路由、插件、鉴权、通知、订单逻辑
├── public/                   # 静态资源：收银台、管理后台、客服页
├── agent/serverless-watcher/ # 可选 NAS/Docker watcher 使用说明（源码未开源，只发布镜像）
├── scripts/                  # 静态资源生成、语法检查与维护脚本
├── tests/                    # 单元测试
├── schema.sql                # D1 表结构
├── package.json              # 模块导出与检查命令
└── .dev.vars.example         # 本地测试变量示例
```

## ePay V1 兼容入口

- 页面支付：`/submit.php`
- API 支付：`POST /mapi.php`
- 查询、订单列表与退款：`/api.php`
- 原通道通知：`/api/pay/{channel_id}/notify`

V1 入参、MD5 排序规则和通知语义保持不变。支付成功后以 GET query 请求商户
`notify_url`，参数包含 `pid`、`trade_no`、`out_trade_no`、`type`、`name`、`money`、
`trade_status=TRADE_SUCCESS`、`sign_type=MD5` 和 `sign`。只有响应正文为 `success`
才算通知成功；失败任务写入同一个 D1，最多重试 8 次。

没有 `/api/v1/*` 自定义下单接口，也没有多商户、Redis、KV、Queue、Durable Object
或第二个业务数据库。

## 管理后台

首页不会显示后台入口，必须手动访问 `/admin`。未登录时直接显示登录页，登录密码来自
Worker Secret `ADMIN_TOKEN`，账号来自普通变量 `ADMIN_USERNAME`。后台包含：

- 商户名称、订单超时和收银台底部安全 HTML 设置；
- 固定插件目录的配置编辑；
- 通道启停和权重路由；
- 最近订单、主动查询、手动补单、冻结/解冻；
- 成功订单重新通知、官方 API 退款和手动退款；
- 通道人工测试。

### 人工通道测试

在“通道管理与权重”表格中点击通道右侧的“测试”，填写测试金额、商品名、支付环境和
可选回调地址，再点击“生成测试订单”。

该操作会直接绑定当前通道创建一笔真实的 `CHTEST...` 待支付单，绕过权重路由并打开
站内支付页。它不会自动支付、不会伪造成功，也不会由后台自动触发商户回调。只有你在
支付页完成支付，或在订单页确认已经实际收款后人工补单，系统才会进入 ePay V1
`notify_url` 签名通知与 `success` 校验流程。弹窗会展示当前通道最近的测试记录。

## 插件与配置存储

固定插件：

- `wxpay_receipt`
- `alipay_receipt`
- `paypal_api`
- `stripe_api`
- `alipay_api`
- `usdt_trc20_receipt`
- `wechat_api`
- `fubei_receipt`

其余收钱吧和商业监听插件也使用同一插件目录与 License 权益控制。新部署不会预置通道，
管理员需要按实际使用的插件逐个新增。码牌类插件也不附带示例收款码，启用前必须上传
自己的二维码。

插件配置只保存在 D1 `runtime_settings` 的一行，并使用 `CONFIG_ENCRYPTION_KEY` 做
AES-GCM 加密；通道和收银台设置各占一行，不保留环境变量副本。密码字段不会回显，
留空就保留现值。新订单默认 5 分钟超时，Cron 和订单查询接口都会把到期状态实际更新为
`EXPIRED`。

微信退款证书只使用 Cloudflare 的 `WECHAT_MTLS` 绑定，不在插件配置或 Worker Secret
中重复保存 PEM/文件路径。

### 支付宝个人收款自监听（免费）

`alipay_receipt` 按原 MPay 的个人支付宝监听约束实现：

- 使用安卓 SmsForwarder，APP 包名必须是 `com.eg.android.AlipayGphone`；
- 转发规则要求通知标题或通知内容包含“元”，通知使用现有 `timestamp + "\\n" + secret`
  HMAC 校验；
- 支持收钱码或经营码，但手机通知无法区分两者，同一配置只能选择其中一个；
- 暂不支持支付宝 PC 通知监听；
- 通知地址由实际通道 ID 生成，不依赖固定的默认通道；
- 可按唯一金额偏移或四位付款备注匹配待支付订单。

### 微信支付 V2 产品

`wechat_api` 继续使用原项目的微信支付 V2 普通商户逻辑，对外仍是 ePay V1；无需让商户
改接口地址或签名规则。后台“插件配置 → 微信官方 API 支付”可分别启用：

- Native 支付：`device=pc`，统一下单使用 `trade_type=NATIVE`，支付页展示微信二维码；
- H5 支付：`device=mobile`、`qq`、`alipay` 或 `jump`，使用 `trade_type=MWEB` 并跳转
  微信返回的 `mweb_url`；
- 公众号 JSAPI：`device=wechat`，可随订单传 `openid`、`sub_openid`、
  `wx_openid` 或 `buyer_open_id`；配置公众号 AppSecret 后，缺少 openid 时会走
  `snsapi_base` 静默授权；
- APP 支付：`device=app`，`POST /mapi.php` 返回 `pay_product=app` 和可直接交给微信
  原生 SDK 的 `pay_info`；
- 小程序支付：随订单传 `mini_openid`，`POST /mapi.php` 返回
  `pay_product=mini`、`app_id` 和可交给 `wx.requestPayment` 的 `pay_info`。

插件中勾选的产品必须已经在微信支付商户平台开通，并且对应公众号、移动应用或小程序
AppID 已与商户号关联。默认 AppID 可供 Native/H5 使用；公众号、APP、小程序可填写各自
AppID，留空时才回退默认 AppID。公众号 AppSecret 仅用于网页授权，不参与支付签名。

### 支付宝官方支付产品

`alipay_api` 保持原项目的密钥模式、RSA2 签名、支付宝响应验签和异步通知校验，对外
仍使用 ePay V1。后台只勾选已经在支付宝开放平台签约并上线的产品：

- 电脑网站支付：PC 环境优先使用 `alipay.trade.page.pay`；
- 手机网站支付：移动端、QQ、微信、支付宝内或 `jump` 环境优先使用
  `alipay.trade.wap.pay`；
- APP 支付：返回 `alipay.trade.app.pay` 的已签名 `order_string`，供原生支付宝 SDK；
- 小程序 JSAPI：调用 `alipay.trade.create`，需 `buyer_open_id` 或 `buyer_id`，以及
  插件配置或订单传入的小程序 AppID；`/mapi.php` 的 `pay_info.tradeNO` 可交给
  `my.tradePay`；
- 订单码支付：调用 `alipay.trade.precreate`，支付页展示支付宝二维码；
- 当面付：调用 `alipay.trade.pay`，必须传入实时付款码 `auth_code`。

自动选择顺序与原 MPay 一致：PC 使用电脑网站 → 订单码 → 手机网站；移动环境使用
手机网站 → 小程序 → 电脑网站 → 订单码；传入付款码时优先当面付。只有支付宝明确返回
“未签约/权限不足”时才尝试后备产品，金额、签名、身份等业务错误不会被掩盖。后台
“通道管理 → 测试”可以明确选择六种产品；当面付会真实发起扣款，必须使用当前有效付款码。

## Docker Watcher

[Docker watcher](./agent/serverless-watcher/README.md) 使用 Node.js 24、Playwright Chromium
和统一 Watcher Plugin API。公开多架构镜像为
`ghcr.io/suk-ldev/edgepay-watcher:latest`，支持 AMD64 与 ARM64，不需要 Redis、KV、Queue
或额外数据库。

Watcher 每 5 秒从 Worker 获取活动订单和签名授权，只启用当前 License 已购买的插件；
完成流水标准化、金额/支付方式/时间窗匹配后，将结果通过 HMAC 签名回传 Worker。Docker
在线并上报对应插件能力时优先接管，离线后 Worker 再接管可直接查询的监听。盛付通的
流水请求依赖官方页面动态加密，只由 Docker 处理；小Y经营同时支持 Docker 和 Worker。

签名头使用通用名称：

```text
x-watcher-timestamp: Unix 秒
x-watcher-signature: v1=base64(HMAC-SHA256("timestamp.METHOD.path.rawBody"))
```

统一使用 `WATCHER_TRANSPORT_SECRET`；部署向导会自动生成该 Secret，并在完成页显示一次。
容器的 `TRANSPORT_KEY` 必须填写相同值。最终去重和订单确认都在 D1。

### Worker 内置轮询与冗余

Docker 离线时，Worker 会查询付呗、收钱吧、支付宝账单、海科码钱、天阙 Pretran、
旺铺管家、TronGrid 和已配置 Token/Cookie 的小Y经营等插件。收银台打开期间会按插件
触发查询；部署向导勾选“启用每分钟后台轮询”后，每分钟 Cron 再补查一次。签名入口用于手动
排查或外部触发：

```text
POST /internal/receipt-poll
```

该入口与 `/api/watcher/snapshot` 使用相同的 `WATCHER_TRANSPORT_SECRET` 和 HMAC 协议。
每个插件使用 D1 `runtime_settings` 中的独立租约，阻止外部高频触发造成同一插件并发
查询；登录 Cookie 和 Token 使用现有 `CONFIG_ENCRYPTION_KEY` 加密保存。NAS Watcher 与 Worker
内置轮询可以同时运行，最终由 `receipt_events(source,event_id)` 唯一约束去重。

不便发送 HMAC 的外部计划任务可使用只具备轮询权限的静态 URL：

```text
GET /internal/receipt-poll?token=<POLL_TRIGGER_TOKEN>
```

`POLL_TRIGGER_TOKEN` 只保存在 Cloudflare Worker Secret，不写入源码或 D1。可直接把完整
URL 放进 HTTP 计划任务，不需要请求头、请求体或 Node。部署向导可选启用每分钟 Cron；
没启用或想比每分钟更快确认时，用这个地址按固定间隔触发即可。URL 属于敏感凭据，不要放入公开日志；泄露后只需轮换该
Secret。接口没有活动订单时不会请求平台或 TronGrid。USDT 在页面截止后仍保留 120 秒
确认宽限，但只接受链上交易时间不晚于订单
截止时间的转账。

响应始终是可读 JSON：顶层 `status` / `message` 给出本轮结论，`summary` 包含当前待监听
订单数、发现流水数、确认成功数、重复数、忽略数和失败数；`results` 按插件列出本轮
确认的支付单号及失败原因。管理后台 `/admin/docs` 会在登录后显示并复制当前完整触发
URL，`/admin/orders` 可查看每笔订单由 Worker 内置轮询、NAS Watcher、SmsForwarder、
官方回调、主动查询或手动补单中的哪一种方式确认。

通道配置的 `order_expire_minutes` 可覆盖全局订单有效期；留空时继承收银台设置。旧通道
配置中的 USDT 会自动迁移为 15 分钟，其他通道继续继承全局值。

## 部署

[![通过官方部署站部署](https://img.shields.io/badge/官方部署站-立即部署-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://deploy.imsuk.cn)

这是唯一受支持的部署入口，所有新建和升级操作都从部署站发起。

部署站会校验你的 Cloudflare Token 与 License，按权益取回对应的商业构建产物
（逐个文件校验 SHA-256），在你自己的账户里创建 D1、写入 Secrets、上传 Worker 并绑定域名。

升级同理：只更新程序内容，保留 D1、Secrets、自定义域名与定时任务。

## 授权

License 与插件权益在 <https://license.imsuk.cn> 获取与管理，支持自助增购和换绑域名。
部署时 License 用于验证域名与交付权益；运行阶段的免费插件不因授权服务临时不可用而停用。

## 许可

见 [MIT License](./LICENSE)。
