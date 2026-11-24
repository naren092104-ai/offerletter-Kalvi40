import nodemailer from 'nodemailer';
import { getSetting } from './db.ts';
import type { EmailConfigPublic } from '../src/types/kalvi40.ts';

export interface SendEmailPayload {
  toEmail: string;
  toName: string;
  ccEmails: string[];
  subject: string;
  bodyText: string;
  attachmentFilename: string;
  attachmentBuffer: Buffer;
}

export interface SendEmailResult {
  success: boolean;
  provider: 'smtp' | 'unconfigured';
  messageId: string | null;
  deliveryStatus: 'accepted' | 'failed';
  errorMessage: string | null;
  retryable: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToCleanEmailHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px 0;line-height:1.6;">${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#10243A;background:#ffffff;padding:24px;">
  <div style="max-width:620px;margin:0 auto;">
    ${paragraphs}
  </div>
</body>
</html>`;
}

export function normalizeSmtpPassword(host: string, rawPassword: string): string {
  const trimmed = rawPassword.trim();
  if (host.toLowerCase().includes('gmail.com')) {
    return trimmed.replace(/\s+/g, '');
  }
  return trimmed;
}

export function isValidSmtpHost(host: string): boolean {
  const clean = host.trim();
  if (!clean || clean.includes('@') || /\s/.test(clean)) return false;
  return true;
}

export function isProviderConfigured(): boolean {
  const host = getSetting('smtp_host', '').trim();
  const user = getSetting('smtp_user', '').trim();
  const pass = getSetting('smtp_pass', '').trim();
  const sender = getSetting('sender_email', '').trim();
  return Boolean(isValidSmtpHost(host) && user && pass && sender);
}

export function getPublicEmailConfig(): EmailConfigPublic {
  const smtpPass = getSetting('smtp_pass', '');

  return {
    email_provider: 'smtp',
    sender_name: getSetting('sender_name', 'BumbleB Trust - Kalvi40'),
    sender_email: getSetting('sender_email', 'prem@bumbleb.org.in'),
    reply_to: getSetting('reply_to', 'prem@bumbleb.org.in'),
    smtp_host: getSetting('smtp_host', 'smtp.gmail.com'),
    smtp_port: getSetting('smtp_port', '587'),
    smtp_user: getSetting('smtp_user', ''),
    smtp_pass_set: Boolean(smtpPass),
    smtp_secure: getSetting('smtp_secure', 'false') === 'true',
    rate_limit_per_minute: Math.max(1, Number(getSetting('rate_limit_per_minute', '45')) || 45),
    max_retries: Math.max(0, Number(getSetting('max_retries', '3')) || 3),
    provider_configured: isProviderConfigured(),
  };
}

export async function verifyEmailProviderConnection(): Promise<{
  ok: boolean;
  provider: string;
  accountInfo?: string;
  error?: string;
}> {
  const host = getSetting('smtp_host', '').trim();
  const port = Number(getSetting('smtp_port', '587')) || 587;
  const user = getSetting('smtp_user', '').trim();
  const pass = normalizeSmtpPassword(host, getSetting('smtp_pass', ''));
  const secure = getSetting('smtp_secure', 'false') === 'true';

  if (!host || !user || !pass) {
    return {
      ok: false,
      provider: 'smtp',
      error: 'SMTP host, username, and password are required before testing the connection.',
    };
  }

  if (!isValidSmtpHost(host)) {
    return {
      ok: false,
      provider: 'smtp',
      error: `Invalid SMTP Host "${host}". Enter a mail server hostname such as smtp.gmail.com, not an email address.`,
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    await transporter.verify();
    return {
      ok: true,
      provider: 'smtp',
      accountInfo: `SMTP verified (${host}:${port} as ${user})`,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'smtp',
      error: err instanceof Error ? err.message : 'SMTP handshake failed.',
    };
  }
}

export async function sendTransactionalOfferEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  const senderEmail = getSetting('sender_email', '').trim();
  const senderName = getSetting('sender_name', 'BumbleB Trust - Kalvi40').trim();
  const replyTo = getSetting('reply_to', senderEmail).trim();

  // Deduplicate and sanitize CCs; strictly exclude candidate email from CC
  const cleanCc = Array.from(
    new Set(
      payload.ccEmails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && e !== payload.toEmail.trim().toLowerCase())
    )
  );

  const host = getSetting('smtp_host', '').trim();
  const port = Number(getSetting('smtp_port', '587')) || 587;
  const user = getSetting('smtp_user', '').trim();
  const pass = normalizeSmtpPassword(host, getSetting('smtp_pass', ''));
  const secure = getSetting('smtp_secure', 'false') === 'true';

  if (!host || !user || !pass || !senderEmail) {
    return {
      success: false,
      provider: 'unconfigured',
      messageId: null,
      deliveryStatus: 'failed',
      errorMessage: 'SMTP credentials are not configured. Configure SMTP settings in Email Configuration before sending.',
      retryable: false,
    };
  }

  if (!isValidSmtpHost(host)) {
    return {
      success: false,
      provider: 'smtp',
      messageId: null,
      deliveryStatus: 'failed',
      errorMessage: `Invalid SMTP Host "${host}". Use a mail server hostname such as smtp.gmail.com.`,
      retryable: false,
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to: `"${payload.toName}" <${payload.toEmail.trim()}>`,
      cc: cleanCc.length > 0 ? cleanCc : undefined,
      replyTo: replyTo || undefined,
      subject: payload.subject,
      text: payload.bodyText,
      html: textToCleanEmailHtml(payload.bodyText),
      attachments: [
        {
          filename: payload.attachmentFilename,
          content: payload.attachmentBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    return {
      success: true,
      provider: 'smtp',
      messageId: info.messageId || null,
      deliveryStatus: 'accepted',
      errorMessage: null,
      retryable: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SMTP delivery error';
    const retryable = /timeout|ECONNRESET|ETIMEDOUT|421|450|451/i.test(msg);
    return {
      success: false,
      provider: 'smtp',
      messageId: null,
      deliveryStatus: 'failed',
      errorMessage: msg,
      retryable,
    };
  }
}
