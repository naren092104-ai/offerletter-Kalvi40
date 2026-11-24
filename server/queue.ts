import fs from 'node:fs';
import path from 'node:path';
import { getSetting, logActivity, requireSupabase } from './store.ts';
import { pdfStorageDir } from './storage.ts';
import { sendTransactionalOfferEmail } from './emailService.ts';
import { generateOfferLetterPdf } from './pdfGenerator.ts';
import { verifyCandidateForSending } from './verification.ts';
import type { Candidate, SendHistoryRecord } from '../src/types/kalvi40.ts';

let isProcessing = false;
let queueTimer: NodeJS.Timeout | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function updateHistory(id: number, patch: Record<string, unknown>): Promise<void> {
  const { error } = await requireSupabase().from('send_history').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`Unable to update Supabase send history: ${error.message}`);
}

async function updateCampaignCounters(campaignId: number | null): Promise<void> {
  if (!campaignId) return;
  const supabase = requireSupabase();
  const { data: rows, error } = await supabase.from('send_history').select('status').eq('campaign_id', campaignId);
  if (error) throw new Error(`Unable to refresh campaign queue state: ${error.message}`);
  const sent = (rows ?? []).filter((row) => row.status === 'sent').length;
  const failed = (rows ?? []).filter((row) => row.status === 'failed').length;
  const pending = (rows ?? []).filter((row) => row.status === 'pending' || row.status === 'processing').length;
  const { error: updateError } = await supabase.from('campaigns').update({ sent_count: sent, failed_count: failed, pending_count: pending, status: pending ? 'processing' : failed ? 'completed_with_errors' : 'completed', ...(pending ? {} : { completed_at: new Date().toISOString() }) }).eq('id', campaignId);
  if (updateError) throw new Error(`Unable to update campaign counters: ${updateError.message}`);
}

async function processSingleQueueItem(item: SendHistoryRecord & { body_rendered: string }): Promise<void> {
  const maxRetries = Math.max(0, Number(getSetting('max_retries', '3')) || 3);
  await updateHistory(item.id, { status: 'processing', attempts: item.attempts + 1 });
  const { data: row, error } = await requireSupabase().from('candidates').select('*').eq('id', item.candidate_id).maybeSingle();
  if (error) throw new Error(`Unable to load candidate for queued email: ${error.message}`);
  if (!row) {
    await updateHistory(item.id, { status: 'failed', delivery_status: 'failed', error_message: 'Candidate record no longer exists.' });
    await updateCampaignCounters(item.campaign_id);
    return;
  }
  const candidate = { ...row, offer_generated: row.offer_generated ? 1 : 0, verification_issues: row.verification_issues == null ? null : JSON.stringify(row.verification_issues) } as Candidate;
  const verification = await verifyCandidateForSending(candidate, { ensurePdfGenerated: true, templateOverride: { subject: item.subject, body: item.body_rendered || '' } });
  if (!verification.valid) {
    await updateHistory(item.id, { status: 'failed', delivery_status: 'failed', error_message: `Verification blocked dispatch: ${verification.issues.join(' | ')}` });
    await updateCampaignCounters(item.campaign_id);
    return;
  }
  const pdfPath = path.join(pdfStorageDir, verification.pdfFilename);
  const pdfBuffer = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : (await generateOfferLetterPdf(candidate)).buffer;
  const ccList = item.cc_emails ? item.cc_emails.split(',').map((email) => email.trim()).filter(Boolean) : [];
  const send = () => sendTransactionalOfferEmail({ toEmail: candidate.email, toName: candidate.candidate_name, ccEmails: ccList, subject: verification.renderedSubject, bodyText: verification.renderedBody, attachmentFilename: verification.pdfFilename, attachmentBuffer: pdfBuffer });
  let result = await send();
  let attempt = item.attempts + 1;
  while (!result.success && result.retryable && attempt <= maxRetries) {
    await sleep(1000 * attempt);
    attempt += 1;
    await updateHistory(item.id, { attempts: attempt });
    result = await send();
  }
  if (result.success) {
    await updateHistory(item.id, { status: 'sent', provider: result.provider, provider_message_id: result.messageId, delivery_status: result.deliveryStatus, error_message: null, sent_at: new Date().toISOString() });
    await logActivity({ adminEmail: 'queue-worker', action: 'EMAIL_SENT', entityType: 'send_history', entityId: item.id, details: `Sent offer letter ${verification.pdfFilename} to ${candidate.email} (Batch ${item.batch_code}) via ${result.provider}` });
  } else {
    await updateHistory(item.id, { status: 'failed', provider: result.provider, delivery_status: 'failed', error_message: result.errorMessage });
    await logActivity({ adminEmail: 'queue-worker', action: 'EMAIL_FAILED', entityType: 'send_history', entityId: item.id, details: `Failed sending to ${candidate.email} (Batch ${item.batch_code}): ${result.errorMessage}` });
  }
  await updateCampaignCounters(item.campaign_id);
}

export async function processEmailQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  const supabase = requireSupabase();
  try {
    const { error: recoverError } = await supabase.from('send_history').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('status', 'processing');
    if (recoverError) throw new Error(`Unable to recover pending email queue: ${recoverError.message}`);
    while (true) {
      const { data: item, error } = await supabase.from('send_history').select('*').eq('status', 'pending').order('id', { ascending: true }).limit(1).maybeSingle();
      if (error) throw new Error(`Unable to read Supabase email queue: ${error.message}`);
      if (!item) break;
      if (item.campaign_id) {
        const { error: campaignError } = await supabase.from('campaigns').update({ status: 'processing' }).eq('id', item.campaign_id).eq('status', 'queued');
        if (campaignError) throw new Error(`Unable to update campaign queue state: ${campaignError.message}`);
      }
      await processSingleQueueItem(item as SendHistoryRecord & { body_rendered: string });
      const ratePerMin = Math.max(1, Number(getSetting('rate_limit_per_minute', '45')) || 45);
      await sleep(Math.max(250, Math.floor(60000 / ratePerMin)));
    }
  } finally { isProcessing = false; }
}

export function triggerQueueWorker(): void {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => { void processEmailQueue().catch((error) => console.error('Email queue worker failed:', error instanceof Error ? error.message : 'unknown error')); }, 50);
}
