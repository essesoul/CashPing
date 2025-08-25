/**
 * Cloudflare Worker: Stripe 支付成功通知聚合器（中文）
 * - 接收并校验 Stripe Webhook（HMAC-SHA256 + 时间容差）
 * - 统一抽取订单信息
 * - 多通道通知（邮件：MailChannels；Server酱Turbo；钉钉自定义机器人；Telegram Bot）
 * - 所有配置走环境变量，网页端一键部署
 *
 * 重要参考（2025-08-25）：
 * - Web Crypto（Workers 原生）用于 HMAC：https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
 * - Stripe Webhook 签名校验（Stripe-Signature）：https://docs.stripe.com/webhooks/signature
 * - Stripe Webhook 总览与事件类型： https://docs.stripe.com/webhooks
 * - MailChannels（Workers 发送邮件 / 新 Email API）：https://support.mailchannels.com/hc/en-us/articles/4565898358413
 * - Server酱 Turbo API： https://sct.ftqq.com/ （API 形如 https://sctapi.ftqq.com/<SENDKEY>.send）
 * - 钉钉机器人安全加签： https://open.dingtalk.com/document/robots/customize-robot-security-settings
 * - Telegram Bot API： https://core.telegram.org/bots/api
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Stripe Webhook 入口
    if (request.method === "POST" && url.pathname === "/stripe-webhook") {
      // 1) 读取原始请求体（字符串）——签名校验需要“原文”
      const rawBody = await request.text();
      const sigHeader = request.headers.get("Stripe-Signature") || "";

      try {
        // 2) 校验签名（异步，见下方实现）
        await verifyStripeSignature({
          signatureHeader: sigHeader,
          payload: rawBody,
          signingSecret: env.STRIPE_WEBHOOK_SECRET, // 必填
          timestampToleranceSec: env.SIG_TOLERANCE_SEC
            ? parseInt(env.SIG_TOLERANCE_SEC, 10)
            : 300, // 默认5分钟
        });

        // 3) 解析事件，仅处理“支付成功”相关
        const evt = JSON.parse(rawBody);
        const okTypes = new Set([
          "payment_intent.succeeded",
          "checkout.session.completed",
          "invoice.payment_succeeded",
        ]);
        if (!okTypes.has(evt.type)) {
          // 其他事件直接忽略并返回 200，避免 Stripe 重试
          return new Response("ignored", { status: 200 });
        }

        // 4) 统一抽取关键信息
        const info = normalizeStripeEvent(evt);

        // 5) 并发发送通知（按是否配置对应 ENV 决定是否启用）
        const tasks = [];

        if (env.MAIL_TO && env.MAIL_FROM) {
          tasks.push(sendMailViaMailChannels(env, info).catch(console.warn));
        }
        if (env.SC_KEY) {
          tasks.push(sendServerChan(env, info).catch(console.warn));
        }
        if (env.DINGTALK_WEBHOOK) {
          tasks.push(sendDingtalk(env, info).catch(console.warn));
        }
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          tasks.push(sendTelegram(env, info).catch(console.warn));
        }

        await Promise.all(tasks);
        return new Response("ok", { status: 200 });
      } catch (err) {
        // 签名校验失败或其它异常
        console.log("handle error:", err?.message || err);
        return new Response("signature verification failed", { status: 400 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

/* -------------------- Stripe 签名校验（异步，WebCrypto） -------------------- */
/**
 * 解析 Stripe-Signature 头，计算 HMAC-SHA256 比对 v1 签名，并做时间容差检查
 * 参考：Stripe 官方签名说明（建议官方 SDK；此处为 Workers 原生实现）
 */
async function verifyStripeSignature({
  signatureHeader,
  payload,
  signingSecret,
  timestampToleranceSec = 300,
}) {
  if (!signingSecret) throw new Error("缺少 STRIPE_WEBHOOK_SECRET");

  // header 形如：t=1700000000,v1=abcdef...,v0=...
  const parts = Object.create(null);
  for (const kv of signatureHeader.split(",")) {
    const [k, v] = kv.trim().split("=");
    if (k && v) parts[k] = v;
  }
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) throw new Error("Stripe-Signature 头无效");

  // 时间容差
  const nowSec = Math.floor(Date.now() / 1000);
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > timestampToleranceSec) {
    throw new Error("签名时间戳超出容差");
  }

  // 签名字符串： `${t}.${payload}`
  const signedPayload = `${t}.${payload}`;
  const macHex = await hmacSHA256Hex(signingSecret, signedPayload);
  if (!constantTimeEqual(macHex, v1)) {
    throw new Error("签名不匹配");
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacSHA256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufferToHex(sig);
}

function bufferToHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* -------------------- 事件归一化 -------------------- */
/**
 * 兼容多种“支付成功”事件：checkout.session、payment_intent、invoice
 * 字段尽量从 data.object 中提取；如缺失则留空或用默认值
 */
function normalizeStripeEvent(evt) {
  const obj = evt.data?.object || {};
  const currency =
    (obj.currency || obj.currency_code || "usd").toString().toUpperCase();
  const amountMinor =
    obj.amount_total ??
    obj.amount_paid ??
    obj.amount_due ??
    obj.amount ??
    obj.amount_captured ??
    0;

  const info = {
    event_type: evt.type,
    id: obj.id || evt.id,
    created_ms: obj.created ? obj.created * 1000 : Date.now(),
    currency,
    amount_minor: amountMinor,
    amount_readable: formatAmount(amountMinor, currency), // e.g. CNY 12.34
    email:
      obj.customer_details?.email ||
      obj.customer_email ||
      obj.receipt_email ||
      obj.billing_details?.email ||
      null,
    order_no:
      obj.id ||
      obj.payment_intent ||
      obj.charge ||
      obj.subscription ||
      obj.invoice ||
      evt.id,
    product_name:
      obj.metadata?.product_name ||
      obj.display_items?.[0]?.custom?.name ||
      obj.metadata?.name ||
      "支付",
    quantity: parseInt(obj.metadata?.quantity || "1", 10) || 1,
    payment_method:
      obj.payment_method_types?.[0] ||
      obj.payment_method_details?.type ||
      obj.payment_method ||
      "stripe",
    customer_id: obj.customer || null,
  };
  return info;
}

function formatAmount(amountMinor, currency) {
  const major = amountMinor / 100; // 常见货币两位小数
  return `${currency} ${major.toFixed(2)}`;
}

/* -------------------- 邮件发送（MailChannels Email API） -------------------- */
/**
 * 说明：MailChannels 过去在 Workers 上的“免注册直发”已于 2024-08-31 下线。
 * 现在需开通 MailChannels Email API（有免费配额），但发送 API 仍是
 * https://api.mailchannels.net/tx/v1/send 的 JSON 格式。
 * 文档与配额说明见官方支持页。
 */
async function sendMailViaMailChannels(env, info) {
  const html = renderEmailHTML(env, info);
  const subject =
    env.MAIL_SUBJECT ||
    `🎉 收款成功 · ${info.amount_readable} · ${info.product_name}`;

  // 允许 MAIL_TO 用逗号分隔多个收件人
  const toList = env.MAIL_TO.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  const body = {
    personalizations: [{ to: toList }],
    from: {
      email: env.MAIL_FROM,
      name: env.MAIL_FROM_NAME || "收款通知",
    },
    subject,
    content: [{ type: "text/html; charset=UTF-8", value: html }],
    // 可选：添加 List-Unsubscribe / 优化可达性头部（自行按需）
    headers: env.MAIL_HEADERS ? JSON.parse(env.MAIL_HEADERS) : undefined,
  };
  const headers = { "content-type": "application/json" };
  if (env.MAILCHANNELS_API_KEY) {
    headers["X-Api-Key"] = env.MAILCHANNELS_API_KEY;
  }
  if (env.MAILCHANNELS_SUBACCOUNT) {
    headers["X-Subaccount"] = env.MAILCHANNELS_SUBACCOUNT;
  }
  const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MailChannels 失败：${resp.status} ${text}`);
  }
}

/* -------------------- Server酱（Turbo） -------------------- */
async function sendServerChan(env, info) {
  const title = `💸 收款成功：${info.amount_readable}`;
  const lines = [
    `**商品**：${info.product_name}`,
    `**金额**：${info.amount_readable}`,
    `**订单号**：\`${info.order_no}\``,
    `**支付方式**：${info.payment_method}`,
    info.email ? `**客户邮箱**：${info.email}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const url = `https://sctapi.ftqq.com/${env.SC_KEY}.send`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp: lines }),
  });
  if (!resp.ok) throw new Error(`Server酱失败：${resp.status}`);
}

/* -------------------- 钉钉机器人 -------------------- */
async function sendDingtalk(env, info) {
  let webhook = env.DINGTALK_WEBHOOK; // 形如 https://oapi.dingtalk.com/robot/send?access_token=XXX
  if (env.DINGTALK_SECRET) {
    // 开启“加签”场景：将 timestamp 和 secret 计算签名后拼接在 webhook 上
    const ts = Date.now();
    const sign = await signDingtalk(ts, env.DINGTALK_SECRET);
    webhook = `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }

  const text = [
    `🎉 收款成功 ${info.amount_readable}`,
    `商品：${info.product_name}`,
    `订单号：${info.order_no}`,
    `方式：${info.payment_method}`,
    info.email ? `客户邮箱：${info.email}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    msgtype: "markdown",
    markdown: { title: "收款成功", text },
  };

  const resp = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Dingtalk 失败：${resp.status}`);
}

async function signDingtalk(timestamp, secret) {
  // 文档：将 `${timestamp}\n${secret}` 以 HmacSHA256 计算，再 Base64，再 urlEncode。Workers 下：
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = `${timestamp}\n${secret}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  // Base64（标准）
  let b64 = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(b64);
}

/* -------------------- Telegram Bot -------------------- */
async function sendTelegram(env, info) {
  const text = [
    "💸 *收款成功*",
    `*金额*：${info.amount_readable}`,
    `*商品*：${escapeMarkdown(info.product_name)}`,
    `*订单号*：\`${info.order_no}\``,
    `*方式*：${info.payment_method}`,
    info.email ? `*客户邮箱*：${escapeMarkdown(info.email)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) throw new Error(`Telegram 失败：${resp.status}`);
}

function escapeMarkdown(s = "") {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/* -------------------- 邮件 HTML 渲染 -------------------- */
/**
 * 你可用 `MAIL_HTML` 环境变量覆盖此模板；
 * 模板变量（用 {{KEY}} 占位）：
 */
function renderEmailHTML(env, info) {
  let tpl = env.MAIL_HTML || DEFAULT_HTML_ZH;
  const map = {
    PRODUCT_NAME: info.product_name,
    QTY: String(info.quantity),
    TOTAL: info.amount_readable,
    ORDER_NO: info.order_no,
    PAID_WITH: info.payment_method,
    CUSTOMER_EMAIL: info.email || "",
  };
  return tpl.replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (_, k) => map[k] ?? "");
}

/* -------------------- 默认中文邮件模板 -------------------- */
const DEFAULT_HTML_ZH = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>CashPing - 收到钱了！</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; background:#f6f7fb; margin:0; padding:24px; }
    .card { max-width:600px; margin:0 auto; background:#fff; border:1px solid #ebebeb; border-radius:12px; overflow:hidden; }
    .hd { padding:24px; border-bottom:1px solid #eff1f4; display:flex; align-items:center; gap:12px; }
    .hd img { height:36px; }
    .bd { padding:24px; }
    .row { display:flex; justify-content:space-between; margin:8px 0; color:#555; }
    .row .k { color:#777; }
    .total { font-size:28px; font-weight:800; color:#222; display:flex; justify-content:space-between; padding:16px 0; border-top:1px solid #eff1f4; border-bottom:1px solid #eff1f4; margin:16px 0; }
    .ft { padding:16px 24px; border-top:1px solid #dfe1e4; font-size:12px; color:#999; }
    @media (prefers-color-scheme: dark) {
      body { background:#0b0b0c; }
      .card { background:#111214; border-color:#2a2c30; }
      .hd { border-color:#2a2c30; }
      .bd .row { color:#c9c9c9; }
      .total { color:#e9e9e9; border-color:#2a2c30; }
      .ft { border-color:#2a2c30; color:#8a8a8a; }
    }
    code { background:#f2f3f5; padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="bd">
      <h2 style="margin:0 0 8px 0;">订单已支付</h2>
      <div class="row"><span class="k">商品</span><span>{{PRODUCT_NAME}} × {{QTY}}</span></div>
      <div class="row"><span class="k">订单号</span><span><code>{{ORDER_NO}}</code></span></div>
      <div class="row"><span class="k">支付方式</span><span>{{PAID_WITH}}</span></div>
      <div class="row"><span class="k">客户邮箱</span><span>{{CUSTOMER_EMAIL}}</span></div>
      <div class="total"><span>合计</span><span>{{TOTAL}}</span></div>
    </div>
    <div class="ft">
      本邮件由系统自动发送，请勿直接回复。
    </div>
  </div>
</body>
</html>`;
