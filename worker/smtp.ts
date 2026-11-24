export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
  startTls(): SmtpSocket;
}

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: boolean },
) => SmtpSocket;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  senderName: string;
  senderEmail: string;
  replyTo?: string;
}

export interface SmtpPayload {
  toEmail: string;
  toName: string;
  ccEmails: string[];
  subject: string;
  bodyText: string;
  attachmentFilename: string;
  attachmentBytes: Uint8Array;
}

export interface SmtpResult {
  success: boolean;
  provider: 'smtp';
  messageId: string | null;
  deliveryStatus: 'accepted' | 'failed';
  errorMessage: string | null;
  retryable: boolean;
}

class SmtpSession {
  private socket: SmtpSocket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(socket: SmtpSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async response(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    let code = 0;
    for (;;) {
      let end = this.buffer.indexOf('\r\n');
      while (end < 0) {
        const chunk = await this.reader.read();
        if (chunk.done) throw new Error('SMTP server closed the connection unexpectedly.');
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        end = this.buffer.indexOf('\r\n');
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      lines.push(line);
      if (lines.length === 1) {
        const match = line.match(/^(\d{3})[- ]/);
        if (!match) throw new Error(`Unexpected SMTP response: ${line}`);
        code = Number(match[1]);
      }
      if (line.startsWith(`${code} `)) break;
    }
    if (code < 200 || code >= 400) throw new Error(`SMTP ${code}: ${lines.join(' ')}`);
    return { code, text: lines.join('\n') };
  }

  async command(command: string): Promise<{ code: number; text: string }> {
    await this.writer.write(this.encoder.encode(`${command}\r\n`));
    return this.response();
  }

  async startTls(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = '';
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* socket may already be closed */ }
    try { await this.socket.close(); } catch { /* best-effort close */ }
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Text(value: string): string {
  return base64(new TextEncoder().encode(value));
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function encodedHeader(value: string): string {
  const safe = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7E]*$/.test(safe) ? safe : `=?UTF-8?B?${base64Text(safe)}?=`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeMimeMessage(config: SmtpConfig, payload: SmtpPayload, messageId: string): string {
  const outer = `kalvi40-${crypto.randomUUID()}-mixed`;
  const inner = `kalvi40-${crypto.randomUUID()}-alternative`;
  const cc = [...new Set(payload.ccEmails.map((email) => email.trim().toLowerCase()))]
    .filter((email) => email && email !== payload.toEmail.trim().toLowerCase());
  const html = payload.bodyText.split(/\n{2,}/).map((part) =>
    `<p style="margin:0 0 14px 0;line-height:1.6">${escapeHtml(part).replace(/\n/g, '<br/>')}</p>`,
  ).join('');
  const lines = [
    `From: ${encodedHeader(config.senderName)} <${config.senderEmail}>`,
    `To: ${encodedHeader(payload.toName)} <${payload.toEmail}>`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(config.replyTo ? [`Reply-To: ${config.replyTo}`] : []),
    `Subject: ${encodedHeader(payload.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Text(payload.bodyText)),
    `--${inner}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Text(`<!doctype html><html><body>${html}</body></html>`)),
    `--${inner}--`,
    `--${outer}`,
    `Content-Type: application/pdf; name="${encodedHeader(payload.attachmentFilename)}"`,
    `Content-Disposition: attachment; filename="${encodedHeader(payload.attachmentFilename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64(payload.attachmentBytes)),
    `--${outer}--`,
    '',
  ];
  return lines.join('\r\n');
}

async function openSession(config: SmtpConfig, connectImpl: SmtpConnect): Promise<SmtpSession> {
  const socket = connectImpl(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? 'on' : 'starttls', allowHalfOpen: true },
  );
  await socket.opened;
  const session = new SmtpSession(socket);
  const greeting = await session.response();
  if (greeting.code !== 220) throw new Error(`SMTP greeting rejected: ${greeting.text}`);
  await session.command('EHLO kalvi40-worker.local');
  if (!config.secure) {
    const startTls = await session.command('STARTTLS');
    if (startTls.code !== 220) throw new Error(`SMTP STARTTLS rejected: ${startTls.text}`);
    await session.startTls();
    await session.command('EHLO kalvi40-worker.local');
  }
  const authPlain = await session.command(`AUTH PLAIN ${base64Text(`\0${config.username}\0${config.password}`)}`).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !/\b5\d\d\b/.test(error.message)) throw error;
    await session.command('AUTH LOGIN');
    await session.command(base64Text(config.username));
    return session.command(base64Text(config.password));
  });
  if (authPlain.code !== 235) throw new Error(`SMTP authentication rejected: ${authPlain.text}`);
  return session;
}

export async function verifySmtpConnection(config: SmtpConfig, connectImpl: SmtpConnect): Promise<{ ok: boolean; provider: string; accountInfo?: string; error?: string }> {
  let session: SmtpSession | null = null;
  try {
    session = await openSession(config, connectImpl);
    await session.command('QUIT');
    return { ok: true, provider: 'smtp', accountInfo: `SMTP verified (${config.host}:${config.port} as ${config.username})` };
  } catch (error) {
    return { ok: false, provider: 'smtp', error: error instanceof Error ? error.message : 'SMTP handshake failed.' };
  } finally {
    await session?.close();
  }
}

export async function sendSmtpEmail(config: SmtpConfig, payload: SmtpPayload, connectImpl: SmtpConnect): Promise<SmtpResult> {
  let session: SmtpSession | null = null;
  const messageId = crypto.randomUUID();
  try {
    if (!config.host || !config.username || !config.password || !config.senderEmail) throw new Error('SMTP host, username, password, and sender address are required.');
    if (/[\r\n]/.test(config.senderEmail) || /[\r\n]/.test(payload.toEmail) || /[\r\n]/.test(payload.subject)) throw new Error('Email headers contain invalid line breaks.');
    session = await openSession(config, connectImpl);
    await session.command(`MAIL FROM:<${config.senderEmail}>`);
    const recipients = [payload.toEmail, ...payload.ccEmails]
      .map((email) => email.trim().toLowerCase())
      .filter((email, index, list) => email && email !== config.senderEmail.toLowerCase() && list.indexOf(email) === index);
    for (const recipient of recipients) await session.command(`RCPT TO:<${recipient}>`);
    await session.command('DATA');
    const message = makeMimeMessage(config, payload, messageId).replace(/(^|\r\n)\./g, '$1..');
    await session.command(message.replace(/\r\n$/, '') + '\r\n.');
    await session.command('QUIT');
    return { success: true, provider: 'smtp', messageId, deliveryStatus: 'accepted', errorMessage: null, retryable: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'SMTP delivery error.';
    return {
      success: false,
      provider: 'smtp',
      messageId: null,
      deliveryStatus: 'failed',
      errorMessage,
      retryable: /timeout|ECONNRESET|ETIMEDOUT|\b421\b|\b450\b|\b451\b/i.test(errorMessage),
    };
  } finally {
    await session?.close();
  }
}
