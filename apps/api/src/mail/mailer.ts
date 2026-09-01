import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';

/**
 * 发信底座（不依赖 Nest DI，供 auth.ts 与 MailService 共用）。
 * provider 由环境变量决定：
 *   aliyun —— 阿里云邮件推送 DirectMail（AK/SK 签名调用 SingleSendMail）
 *   smtp   —— 任意 SMTP（开发环境 Mailpit 走这个）
 *   none   —— 未配置，静默跳过
 */

type Provider = 'aliyun' | 'smtp' | 'none';

function detectProvider(): Provider {
  const explicit = (process.env.MAIL_PROVIDER || '').toLowerCase();
  if (explicit === 'aliyun' || explicit === 'smtp' || explicit === 'none') {
    return explicit;
  }
  if (process.env.ALIYUN_DM_ACCESS_KEY_ID) return 'aliyun';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

const provider = detectProvider();

let transporter: nodemailer.Transporter | undefined;
if (provider === 'smtp') {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

export const mailProvider = provider;
export const mailEnabled = provider !== 'none';

/** 前端站点地址（邮件里链接用） */
export function appUrl(): string {
  return (
    process.env.APP_URL ||
    (process.env.AUTH_TRUST_ORIGINS || '').split(',')[0] ||
    'http://localhost:5173'
  );
}

// ---------- 阿里云 DirectMail ----------

/** 阿里云 RPC 风格签名要求的百分号编码 */
function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function sendViaAliyun(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const ak = process.env.ALIYUN_DM_ACCESS_KEY_ID!;
  const sk = process.env.ALIYUN_DM_ACCESS_KEY_SECRET!;
  const account = process.env.ALIYUN_DM_ACCOUNT || 'noreply@mail.cloudcele.com';
  const region = process.env.ALIYUN_DM_REGION || 'cn-hangzhou';
  const endpoint =
    process.env.ALIYUN_DM_ENDPOINT || 'https://dm.aliyuncs.com/';

  const params: Record<string, string> = {
    Format: 'JSON',
    Version: '2015-11-23',
    AccessKeyId: ak,
    SignatureMethod: 'HMAC-SHA1',
    // ISO8601 UTC，不带毫秒
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    RegionId: region,
    Action: 'SingleSendMail',
    AccountName: account,
    AddressType: '1', // 1 = 使用发信地址
    ReplyToAddress: 'false',
    ToAddress: to,
    Subject: subject,
    HtmlBody: html,
  };
  const alias = process.env.ALIYUN_DM_FROM_ALIAS;
  if (alias) params.FromAlias = alias;

  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = crypto
    .createHmac('sha1', `${sk}&`)
    .update(stringToSign)
    .digest('base64');

  const body = new URLSearchParams({ ...params, Signature: signature });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DirectMail ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ---------- 统一出口 ----------

/** 发送邮件；未配置发信服务时静默跳过。失败抛错由调用方决定是否忽略。 */
export async function sendMail(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  if (!to || provider === 'none') return;
  if (provider === 'aliyun') {
    await sendViaAliyun(to, subject, html);
    return;
  }
  await transporter!.sendMail({
    from: process.env.SMTP_FROM || '工单系统 <no-reply@example.com>',
    to,
    subject,
    html,
  });
}

/** 发送并吞掉异常（通知类邮件用，不阻塞主流程） */
export async function sendMailSafe(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  try {
    await sendMail(to, subject, html);
  } catch (e) {
    console.warn(`[Mail] 发送失败 -> ${to}: ${(e as Error).message}`);
  }
}

const esc = (s = '') =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
      c
    ]!,
  );

/** 统一的邮件模板：标题 + 正文 + 行动按钮 */
export function mailTemplate(opts: {
  heading: string;
  body?: string;
  actionText?: string;
  actionUrl?: string;
  footer?: string;
}): string {
  const { heading, body, actionText, actionUrl, footer } = opts;
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px;font-size:18px">${esc(heading)}</h2>
  ${body ? `<p style="margin:0 0 16px;line-height:1.6;color:#444">${esc(body)}</p>` : ''}
  ${
    actionUrl
      ? `<p style="margin:0 0 16px">
      <a href="${actionUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px">${esc(actionText || '打开')}</a>
    </p>
    <p style="margin:0 0 16px;font-size:12px;color:#888;word-break:break-all">如果按钮无法点击，请复制链接到浏览器打开：<br>${actionUrl}</p>`
      : ''
  }
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
  <p style="font-size:12px;color:#888;margin:0">${esc(footer || '本邮件由工单管理系统自动发送，请勿直接回复。')}</p>
</div>`;
}
