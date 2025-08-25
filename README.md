# CashPing 收到钱了 - Stripe 收款通知聚合器

当 **Stripe** 收到支付成功事件时，自动通过 **邮件（MailChannels）/ Server酱Turbo / 钉钉机器人 / Telegram Bot** 等渠道把“喜讯”推送给你。  
**单文件部署**、**全部配置走环境变量**，无需改代码，即可在 Cloudflare 网页端完成上线。

> 📌 邮件模板已内置中文样式（简洁、适配深浅色），支持以占位符方式（`{{KEY}}`）替换。  
> 📌 只处理“支付成功”相关事件：`payment_intent.succeeded`、`checkout.session.completed`、`invoice.payment_succeeded`。

---

## ✨ 功能特性

- ✅ Stripe Webhook 校验（`Stripe-Signature` + HMAC-SHA256 + 时间容差）
- ✅ 多通道通知：MailChannels（邮件）、Server酱Turbo、钉钉自定义机器人、Telegram Bot
- ✅ 单文件 Worker 部署，**全部参数用环境变量**管理
- ✅ 邮件模板中文化、默认美化，可用 `MAIL_HTML` 一键覆盖
- ✅ 健康检查 `/health`

---

## 📦 目录与文件


```text
.
├─ worker.js # 粘贴到 Cloudflare 控制台即可
└─ README.md
```


---

## 🚀 快速开始（Cloudflare 网页端）

1. **创建 Worker**
   - 进入 Cloudflare Dashboard → Workers → Create
   - 选择“HTTP handler”类型，粘贴 `worker.js` 全部代码 → Save & Deploy

2. **设置环境变量**（Settings → Variables）
   - 必填：`STRIPE_WEBHOOK_SECRET`、（如需邮件）`MAIL_TO`、`MAIL_FROM`
   - 其他可选变量见下文“环境变量对照表”

3. **配置路由（Routes）**
   - 将你的域名路径（如 `https://payhooks.example.com/stripe-webhook`）指向该 Worker
   - 或直接使用 Worker 提供的子域路径

4. **配置 Stripe Webhook**
   - Stripe 控制台 → Developers → Webhooks → “Add an endpoint”
   - URL 指向 `…/stripe-webhook`
   - 订阅事件勾选：
     - `payment_intent.succeeded`
     - `checkout.session.completed`
     - `invoice.payment_succeeded`
   - 保存后复制 **Signing secret**，填入 `STRIPE_WEBHOOK_SECRET`

5. **（可选）自定义邮件模板**
   - 将你的 HTML 模板粘贴到 `MAIL_HTML` 环境变量
   - 使用本文支持的占位符（见下文“模板占位符”）进行变量替换

---

## ⚙️ 环境变量对照表

> **所有变量都在 Cloudflare 控制台 → Workers → 你的服务 → Settings → Variables 中设置。**

### 核心配置

| 变量名 | 必填 | 示例/说明 |
|---|:---:|---|
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe Webhook Endpoint 的 Signing secret（非 API Key） |
| `SIG_TOLERANCE_SEC` | ❶ | 签名时间容差（秒），默认 `300`（5 分钟） |

> ❶ 可选；不设置则默认 300。

### 邮件（MailChannels）

| 变量名 | 必填 | 示例/说明 |
|---|:---:|---|
| `MAIL_TO` | ✳︎ | 收件人邮箱，支持多个（逗号分隔）`you@example.com,ops@example.com` |
| `MAIL_FROM` | ✳︎ | 发件人邮箱，例如 `no-reply@yourdomain.com` |
| `MAIL_FROM_NAME` |  | 发件人显示名，默认“收款通知” |
| `MAIL_SUBJECT` |  | 自定义邮件标题（默认：`🎉 收款成功 · <金额> · <商品>`） |
| `MAIL_HEADERS` |  | 额外头部（JSON 字符串），如 `{"List-Unsubscribe":"<mailto:...>"}` |
| `MAIL_HTML` |  | 覆盖默认中文模板的完整 HTML（支持占位符） |

> ✳︎ 当你希望启用**邮件通知**时，`MAIL_TO` 和 `MAIL_FROM` 必填。

### Server酱 Turbo

| 变量名 | 必填 | 示例/说明 |
|---|:---:|---|
| `SC_KEY` | ✳︎ | Turbo 版 SendKey，用于 `https://sctapi.ftqq.com/<SC_KEY>.send` |

> ✳︎ 配置后自动启用 Server酱通知。

### 钉钉自定义机器人

| 变量名 | 必填 | 示例/说明 |
|---|:---:|---|
| `DINGTALK_WEBHOOK` | ✳︎ | 完整 Webhook URL（access_token 版本） |
| `DINGTALK_SECRET` |  | 机器人安全设置中的“加签”秘钥（启用加签时必填） |

> ✳︎ 配置 `DINGTALK_WEBHOOK` 即启用；若开启“加签”，需同时配置 `DINGTALK_SECRET`。

### Telegram Bot

| 变量名 | 必填 | 示例/说明 |
|---|:---:|---|
| `TELEGRAM_BOT_TOKEN` | ✳︎ | BotFather 颁发的 token |
| `TELEGRAM_CHAT_ID` | ✳︎ | 群或用户的 chat_id（可用 @RawDataBot / 机器人消息获取） |

> ✳︎ 两者都配置后启用 Telegram 通知。

---

## 🧩 模板占位符（用于 `MAIL_HTML`）

| 含义 | 占位符 |
|---|---|
| 站点地址 | `{{SITE_URL}}` |
| Logo URL | `{{LOGO_URL}}` |
| 商品名 | `{{PRODUCT_NAME}}` |
| 数量 | `{{QTY}}` |
| 订单号 | `{{ORDER_NO}}` |
| 支付方式 | `{{PAID_WITH}}` |
| 客户邮箱 | `{{CUSTOMER_EMAIL}}` |
| 合计金额（含币种） | `{{TOTAL}}` |

> 默认中文模板**不会显示**站点名；你可自由在 `MAIL_HTML` 中加入其他自定义内容。

---

## 🔧 本地/线上测试

### 1）健康检查
```bash
curl -i https://<你的域名或workers子域>/health
# 200 ok
```

### 2）Stripe 测试事件（控制台）

- Stripe 控制台 → Webhooks → 选中你的 Endpoint → “Send test event”

- 选择 `payment_intent.succeeded`（或其他两个成功事件）发送
