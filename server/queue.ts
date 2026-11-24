import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, logActivity, pdfStorageDir } from './db.ts';
import { sendTransactionalOfferEmail } from './emailService.ts';
import { generateOfferLetterPdf } from './pdfGenerator.ts';
import { verifyCandidateForSending } from './verification.ts';
import type { Candidate, SendHistoryRecord } from '../src/types/kalvi40.ts';

let isProcessing = false;
let queueTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateCampaignCounters(campaignId: number | null): void {
  if (!campaignId) return;
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) as pending_count
    FROM send_history
    WHERE campaign_id = ?
  `).get(campaignId) as {
    total: number;
    sent_count: number | null;
    failed_count: number | null;
    pending_count: number | null;
  };

  const sent = stats.sent_count || 0;
  const failed = stats.failed_count || 0;
  const pending = stats.pending_count || 0;

  let campaignStatus: string = 'processing';
  let completedAt: string | null = null;
  if (pending === 0) {
    campaignStatus = failed > 0 ? 'completed_with_errors' : 'completed';
    completedAt = new Date().toISOString();
  }

  db.prepare(`
    UPDATE campaigns
    SET sent_count = ?,
        failed_count = ?,
        pending_count = ?,
        status = ?,
        completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `).run(sent, failed, pending, campaignStatus, completedAt, campaignId);
}

async function processSingleQueueItem(item: SendHistoryRecord): Promise<void> {
  const maxRetries = Math.max(0, Number(getSetting('max_retries', '3')) || 3);

  db.prepare(`
    UPDATE send_history
    SET status = 'processing',
        attempts = attempts + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(item.id);

  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(item.candidate_id) as Candidate | undefined;
  if (!candidate) {
    db.prepare(`
      UPDATE send_history
      SET status = 'failed',
          delivery_status = 'failed',
          error_message = 'Candidate record no longer exists.',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(item.id);
    updateCampaignCounters(item.campaign_id);
    return;
  }

  // Always verify DB vs Email vs PDF right before dispatching
  const verification = await verifyCandidateForSending(candidate, {
    ensurePdfGenerated: true,
    templateOverride: {
      subject: item.subject,
      body: (item as SendHistoryRecord & { body_rendered?: string }).body_rendered || '',
    },
  });

  if (!verification.valid) {
    db.prepare(`
      UPDATE send_history
      SET status = 'failed',
          delivery_status = 'failed',
          error_message = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(`Verification blocked dispatch: ${verification.issues.join(' | ')}`, item.id);
    updateCampaignCounters(item.campaign_id);
    return;
  }

  const pdfPath = path.join(pdfStorageDir, verification.pdfFilename);
  let pdfBuffer: Buffer;
  if (fs.existsSync(pdfPath)) {
    pdfBuffer = fs.readFileSync(pdfPath);
  } else {
    const generated = await generateOfferLetterPdf(candidate);
    pdfBuffer = generated.buffer;
  }

  const ccList = item.cc_emails
    ? item.cc_emails.split(',').map((e) => e.trim()).filter(Boolean)
    : [];

  let attemptResult = await sendTransactionalOfferEmail({
    toEmail: candidate.email,
    toName: candidate.candidate_name,
    ccEmails: ccList,
    subject: verification.renderedSubject,
    bodyText: verification.renderedBody,
    attachmentFilename: verification.pdfFilename,
    attachmentBuffer: pdfBuffer,
  });

  // Retry temporary failures up to maxRetries
  let currentAttempt = item.attempts + 1;
  while (!attemptResult.success && attemptResult.retryable && currentAttempt <= maxRetries) {
    await sleep(1000 * currentAttempt);
    currentAttempt++;
    db.prepare('UPDATE send_history SET attempts = ?, updated_at = datetime(\'now\') WHERE id = ?').run(currentAttempt, item.id);
    attemptResult = await sendTransactionalOfferEmail({
      toEmail: candidate.email,
      toName: candidate.candidate_name,
      ccEmails: ccList,
      subject: verification.renderedSubject,
      bodyText: verification.renderedBody,
      attachmentFilename: verification.pdfFilename,
      attachmentBuffer: pdfBuffer,
    });
  }

  if (attemptResult.success) {
    db.prepare(`
      UPDATE send_history
      SET status = 'sent',
          provider = ?,
          provider_message_id = ?,
          delivery_status = ?,
          error_message = NULL,
          sent_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(attemptResult.provider, attemptResult.messageId, attemptResult.deliveryStatus, item.id);

    logActivity({
      adminEmail: 'queue-worker',
      action: 'EMAIL_SENT',
      entityType: 'send_history',
      entityId: item.id,
      details: `Sent offer letter ${verification.pdfFilename} to ${candidate.email} (Batch ${item.batch_code}) via ${attemptResult.provider}`,
    });
  } else {
    db.prepare(`
      UPDATE send_history
      SET status = 'failed',
          provider = ?,
          delivery_status = 'failed',
          error_message = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(attemptResult.provider, attemptResult.errorMessage, item.id);

    logActivity({
      adminEmail: 'queue-worker',
      action: 'EMAIL_FAILED',
      entityType: 'send_history',
      entityId: item.id,
      details: `Failed sending to ${candidate.email} (Batch ${item.batch_code}): ${attemptResult.errorMessage}`,
    });
  }

  updateCampaignCounters(item.campaign_id);
}

export async function processEmailQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Recover any tasks that were mid-flight during an unexpected server restart
    db.prepare(`
      UPDATE send_history
      SET status = 'pending', updated_at = datetime('now')
      WHERE status = 'processing'
    `).run();

    while (true) {
      const nextItem = db.prepare(`
        SELECT * FROM send_history
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `).get() as (SendHistoryRecord & { body_rendered: string }) | undefined;

      if (!nextItem) break;

      if (nextItem.campaign_id) {
        db.prepare(`UPDATE campaigns SET status = 'processing' WHERE id = ? AND status = 'queued'`).run(nextItem.campaign_id);
      }

      await processSingleQueueItem(nextItem);

      const ratePerMin = Math.max(1, Number(getSetting('rate_limit_per_minute', '45')) || 45);
      const delayMs = Math.max(250, Math.floor(60000 / ratePerMin));
      await sleep(delayMs);
    }
  } finally {
    isProcessing = false;
  }
}

export function triggerQueueWorker(): void {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    void processEmailQueue();
  }, 50);
}
