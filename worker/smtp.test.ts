import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendSmtpEmail, verifySmtpConnection, type SmtpConfig, type SmtpConnect, type SmtpSocket } from './smtp.ts';

const config: SmtpConfig = {
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  username: 'sender@example.test',
  password: 'test-password',
  senderName: 'Kalvi40 Test',
  senderEmail: 'sender@example.test',
  replyTo: 'reply@example.test',
};

function fakeConnect(responses: string[], writes: string[]): SmtpConnect {
  return () => {
    const responseText = responses.join('');
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText));
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk));
      },
    });
    const socket: SmtpSocket = {
      readable,
      writable,
      opened: Promise.resolve({}),
      closed: Promise.resolve(),
      async close() {},
      startTls() { return socket; },
    };
    return socket;
  };
}

test('SMTP dispatch performs auth, sends MIME attachment, and deduplicates candidate CC', async () => {
  const writes: string[] = [];
  const connect = fakeConnect([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n', '250 sender ok\r\n',
    '250 recipient ok\r\n', '250 cc ok\r\n', '354 send content\r\n', '250 queued id\r\n', '221 bye\r\n',
  ], writes);
  const result = await sendSmtpEmail(config, {
    toEmail: 'candidate@example.test',
    toName: 'Candidate',
    ccEmails: ['cc@example.test', 'CC@example.test', 'candidate@example.test'],
    subject: 'Offer',
    bodyText: 'Hello\nWorld',
    attachmentFilename: 'offer.pdf',
    attachmentBytes: new TextEncoder().encode('%PDF-test'),
  }, connect);
  assert.equal(result.success, true);
  assert.equal(result.deliveryStatus, 'accepted');
  assert.ok(writes.some((write) => write.startsWith('MAIL FROM:<sender@example.test>')));
  assert.equal(writes.filter((write) => write.startsWith('RCPT TO:<cc@example.test>')).length, 1);
  assert.ok(writes.some((write) => write.includes('Content-Type: application/pdf')));
});

test('SMTP connection verification authenticates without sending a message', async () => {
  const writes: string[] = [];
  const result = await verifySmtpConnection(config, fakeConnect([
    '220 ready\r\n', '250 hello\r\n', '235 authenticated\r\n', '221 bye\r\n',
  ], writes));
  assert.equal(result.ok, true);
  assert.match(result.accountInfo || '', /smtp\.example\.test/);
  assert.equal(writes.some((write) => write.startsWith('MAIL FROM:')), false);
});

test('SMTP transient failures are marked retryable', async () => {
  const writes: string[] = [];
  const result = await sendSmtpEmail(config, {
    toEmail: 'candidate@example.test', toName: 'Candidate', ccEmails: [], subject: 'Offer',
    bodyText: 'Hello', attachmentFilename: 'offer.pdf', attachmentBytes: new Uint8Array([1, 2, 3]),
  }, fakeConnect(['421 temporary server failure\r\n'], writes));
  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
});
