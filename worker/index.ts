/**
 * Phase 1 Cloudflare Worker API for Kalvi40.
 * Admin login uses the existing Supabase admins table and custom bcrypt/JWT auth.
 * Other existing Express API routes remain in place and are not yet fully ported.
 */
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import * as XLSX from 'xlsx';
import {
  DEFAULT_MASTER_BODY,
  DEFAULT_MASTER_SUBJECT,
  DEFAULT_OFFER_LETTER_TEMPLATE,
  formatDateDDMMYYYY,
  normalizeSchoolName,
  renderTemplateString,
  sanitizeOfferFilename,
} from '../src/types/kalvi40.ts';
import { buildOfferLetterPdfBuffer, extractPdfText } from './pdf.ts';
import { sendSmtpEmail, verifySmtpConnection, type SmtpConfig, type SmtpConnect, type SmtpPayload, type SmtpResult } from './smtp.ts';

export interface Env {
  JWT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SMTP_PASS?: string;
  SUPABASE_STORAGE_BUCKET: string;
  ALLOWED_ORIGIN?: string;
  EMAIL_QUEUE?: {
    send: (msg: BulkEmailJob) => Promise<void>;
  };
}

interface BulkEmailJob {
  historyId: number;
  campaignId: number;
  candidateId: number;
  toEmail: string;
  toName: string;
  ccEmails: string[];
  subject: string;
  bodyText: string;
  pdfFilename: string;
}

interface WorkerQueueMessage {
  body: BulkEmailJob;
  attempts?: number;
  ack: () => void;
  retry: (options?: { delaySeconds?: number }) => void;
}

const now = () => new Date().toISOString();
const secretSettingPattern = /(?:pass(?:word)?|secret|api.?key|token|credential)/i;
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function normalizeCandidate<T extends Record<string, unknown>>(row: T): T & { offer_generated: number; verification_issues: string | null; last_send_status: unknown } {
  const issues = row.verification_issues;
  return {
    ...row,
    offer_generated: row.offer_generated ? 1 : 0,
    verification_issues: issues == null ? null : typeof issues === 'string' ? issues : JSON.stringify(issues),
    last_send_status: row.last_send_status ?? null,
  } as T & { offer_generated: number; verification_issues: string | null; last_send_status: unknown };
}

async function recordAdminActivity(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  request: Request,
  session: Record<string, unknown>,
  action: string,
  entityType: string,
  details: string,
  entityId?: number | string | null,
): Promise<void> {
  const forwardedFor = request.headers.get('x-forwarded-for') || '';
  const ipAddress = forwardedFor.split(',')[0].trim() || request.headers.get('cf-connecting-ip');
  const { error } = await supabase.from('activity_logs').insert({
    admin_id: Number(session.id),
    admin_email: String(session.email || 'unknown'),
    action,
    entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId),
    details,
    ip_address: ipAddress,
  });
  if (error) throw new Error(`Unable to write activity log: ${error.message}`);
}

async function deleteCandidateFiles(supabase: ReturnType<typeof createPrivilegedSupabaseClient>, env: Env, rows: Array<Record<string, unknown>>): Promise<void> {
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.offer_filename === 'string' && row.offer_filename) names.add(row.offer_filename.split(/[\\/]/).pop() || '');
    if (typeof row.candidate_name === 'string' && row.candidate_name) names.add(sanitizeOfferFilename(row.candidate_name));
  }
  const safeNames = [...names].filter((name) => name && !name.includes('..'));
  if (safeNames.length) {
    await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters').remove(safeNames).catch(() => undefined);
  }
}

async function getCandidate(supabase: ReturnType<typeof createPrivilegedSupabaseClient>, candidateId: number) {
  const { data, error } = await supabase.from('candidates').select('*').eq('id', candidateId).maybeSingle();
  if (error) throw new Error(`Unable to read candidate from Supabase: ${error.message}`);
  return data ? normalizeCandidate(data) : null;
}

async function generateAndStorePdf(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  env: Env,
  candidate: Record<string, unknown>,
) {
  const settings = await loadSettings(supabase);
  const template = offerTemplateFromSettings(settings);
  let signature: { bytes: Uint8Array; mime: string; heightPt: number } | null = null;
  const signatureFilename = settings.get('founder_signature_filename')?.trim() || '';
  if (signatureFilename && !signatureFilename.includes('/') && !signatureFilename.includes('\\') && !signatureFilename.includes('..')) {
    const { data: signatureBlob, error: signatureError } = await supabase.storage
      .from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters').download(signatureFilename);
    if (!signatureError && signatureBlob) {
      const height = Number(settings.get('founder_signature_height') || 40);
      signature = {
        bytes: new Uint8Array(await signatureBlob.arrayBuffer()),
        mime: settings.get('founder_signature_mime') || 'image/png',
        heightPt: Number.isFinite(height) ? Math.max(24, Math.min(72, Math.round(height))) : 40,
      };
    }
  }
  const { bytes, filename } = await buildOfferLetterPdfBuffer(candidate, template, signature);
  const { error: storageError } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters')
    .upload(filename, bytes, { contentType: 'application/pdf', upsert: true });
  if (storageError) throw new Error(`Unable to save offer letter PDF to Supabase Storage: ${storageError.message}`);
  const timestamp = now();
  const { error } = await supabase.from('candidates').update({
    offer_generated: true,
    offer_generated_at: timestamp,
    offer_filename: filename,
    verification_status: 'unverified',
    verification_issues: null,
    updated_at: timestamp,
  }).eq('id', candidate.id);
  if (error) throw new Error(`PDF was stored but candidate metadata could not be updated: ${error.message}`);
  return { bytes, filename };
}

async function loadStoredPdf(supabase: ReturnType<typeof createPrivilegedSupabaseClient>, env: Env, filename: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters').download(filename);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function verifyCandidateForSending(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  env: Env,
  candidate: Record<string, unknown>,
  templateOverride?: { subject: string; body: string },
  ensurePdfGenerated = true,
) {
  const settings = await loadSettings(supabase);
  const offerTemplate = offerTemplateFromSettings(settings);
  const { data: master, error: masterError } = templateOverride
    ? { data: templateOverride, error: null }
    : await supabase.from('email_templates').select('*').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
  if (masterError) throw new Error(`Unable to load master email template: ${masterError.message}`);
  if (!master) throw new Error('Master email template is missing from Supabase.');
  const renderedSubject = renderTemplateString(String(master.subject), candidate as never, {
    contract_end_date: offerTemplate.contract_end_date,
    stipend_text: offerTemplate.stipend_text,
  });
  const renderedBody = renderTemplateString(String(master.body), candidate as never, {
    contract_end_date: offerTemplate.contract_end_date,
    stipend_text: offerTemplate.stipend_text,
  });
  const filename = sanitizeOfferFilename(String(candidate.candidate_name || 'Candidate'));
  let bytes = !ensurePdfGenerated && candidate.offer_generated ? await loadStoredPdf(supabase, env, filename) : null;
  if (!bytes) bytes = (await generateAndStorePdf(supabase, env, candidate)).bytes;
  const extracted = await extractPdfText(bytes);
  const normalized = extracted.toLowerCase().replace(/\s+/g, ' ').trim();
  const candidateName = String(candidate.candidate_name || '').trim();
  const location = String(candidate.location || '').trim();
  const district = String(candidate.district || '').trim();
  const joiningDate = formatDateDDMMYYYY(String(candidate.joining_date || ''));
  const unresolved = [...new Set([
    ...(renderedSubject.match(/\{\{[^}]+\}\}/g) ?? []),
    ...(renderedBody.match(/\{\{[^}]+\}\}/g) ?? []),
    ...(extracted.match(/\{\{[^}]+\}\}/g) ?? []),
  ])];
  const nameInEmail = Boolean(candidateName && renderedBody.toLowerCase().includes(candidateName.toLowerCase()));
  const nameInPdf = Boolean(candidateName && normalized.includes(candidateName.toLowerCase()));
  const schoolText = normalizeSchoolName(String(candidate.school_name || '')).toLowerCase();
  const customBody = typeof candidate.custom_offer_body === 'string' && candidate.custom_offer_body.trim() ? candidate.custom_offer_body : offerTemplate.body;
  const checkItems = [
    { key: 'required_fields', label: 'Candidate Profile Completeness', passed: Boolean(candidateName && candidate.school_name && location && district && candidate.joining_date), message: 'Candidate fields are checked before dispatch.' },
    { key: 'email_format', label: 'Valid Recipient Email', passed: validEmail(String(candidate.email || '').trim()), expected: 'valid@domain.tld', actual: candidate.email, message: validEmail(String(candidate.email || '').trim()) ? 'Recipient email is syntactically valid.' : 'Invalid recipient email address.' },
    { key: 'no_unresolved_placeholders', label: 'Template Placeholder Resolution', passed: unresolved.length === 0, message: unresolved.length ? `Unresolved placeholders found: ${unresolved.join(', ')}.` : 'No unresolved placeholders found in email or PDF.' },
    { key: 'name_match_email', label: 'Name Match: Database vs Email Body', passed: nameInEmail, expected: candidateName, actual: nameInEmail ? candidateName : 'Not found in email body', message: nameInEmail ? `Email body addresses "${candidateName}".` : `Candidate name "${candidateName}" was not found in the rendered email body.` },
    { key: 'name_match_pdf', label: 'Name Match: Database vs Generated PDF', passed: bytes.length > 500 && nameInPdf, expected: candidateName, actual: nameInPdf ? candidateName : 'Not found in PDF text', message: nameInPdf ? `PDF text contains "${candidateName}".` : `Candidate name "${candidateName}" could not be verified in ${filename}.` },
    { key: 'placement_match_pdf', label: 'School, Location, District & Date in PDF', passed: normalized.includes(schoolText.toLowerCase()) && normalized.includes(location.toLowerCase()) && normalized.includes(district.toLowerCase()) && normalized.includes(joiningDate.toLowerCase()), message: 'School, location, district, and joining date are checked against extracted PDF text.' },
    { key: 'pdf_ready', label: 'Offer Letter PDF Attachment Ready', passed: bytes.length > 500, expected: filename, actual: `${filename} (${Math.round(bytes.length / 1024)} KB)`, message: 'PDF is stored and ready as an email attachment.' },
  ];
  const issues = checkItems.filter((item) => !item.passed).map((item) => item.message);
  const valid = issues.length === 0;
  const { error: updateError } = await supabase.from('candidates').update({
    verification_status: valid ? 'verified' : 'failed',
    verification_issues: valid ? null : issues,
    updated_at: now(),
  }).eq('id', candidate.id);
  if (updateError) throw new Error(`Unable to save candidate verification in Supabase: ${updateError.message}`);
  return { candidateId: Number(candidate.id), valid, pdfFilename: filename, pdfExists: bytes.length > 500, renderedSubject, renderedBody, checks: checkItems, issues };
}

async function logWorkerActivity(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  action: string,
  entityType: string,
  details: string,
  entityId?: number | string | null,
): Promise<void> {
  const { error } = await supabase.from('activity_logs').insert({
    admin_id: null,
    admin_email: 'queue-worker',
    action,
    entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId),
    details,
    ip_address: null,
  });
  if (error) throw new Error(`Unable to write queue activity: ${error.message}`);
}

async function updateCampaignCounters(supabase: ReturnType<typeof createPrivilegedSupabaseClient>, campaignId: number | null): Promise<void> {
  if (!campaignId) return;
  const { data: rows, error } = await supabase.from('send_history').select('status').eq('campaign_id', campaignId);
  if (error) throw new Error(`Unable to refresh campaign queue state: ${error.message}`);
  const sent = (rows ?? []).filter((row) => row.status === 'sent').length;
  const failed = (rows ?? []).filter((row) => row.status === 'failed').length;
  const pending = (rows ?? []).filter((row) => row.status === 'pending' || row.status === 'processing').length;
  const { error: updateError } = await supabase.from('campaigns').update({
    sent_count: sent,
    failed_count: failed,
    pending_count: pending,
    status: pending ? 'processing' : failed ? 'completed_with_errors' : 'completed',
    ...(pending ? {} : { completed_at: now() }),
  }).eq('id', campaignId);
  if (updateError) throw new Error(`Unable to update campaign counters: ${updateError.message}`);
}

async function processQueueMessage(message: WorkerQueueMessage, env: Env): Promise<void> {
  const job = message.body;
  const supabase = createPrivilegedSupabaseClient(env);
  const { data: history, error: historyError } = await supabase.from('send_history').select('*').eq('id', job.historyId).maybeSingle();
  if (historyError) throw new Error(`Unable to load queue history item: ${historyError.message}`);
  if (!history || history.status === 'sent') {
    message.ack();
    return;
  }
  const attempt = Number(history.attempts || 0) + 1;
  const { error: processingError } = await supabase.from('send_history')
    .update({ status: 'processing', attempts: attempt, updated_at: now() }).eq('id', job.historyId);
  if (processingError) throw new Error(`Unable to mark queue item processing: ${processingError.message}`);

  const failJob = async (errorMessage: string, provider = 'smtp') => {
    await supabase.from('send_history').update({
      status: 'failed',
      delivery_status: 'failed',
      provider,
      error_message: errorMessage,
      updated_at: now(),
    }).eq('id', job.historyId);
    await updateCampaignCounters(supabase, job.campaignId || null);
    await logWorkerActivity(supabase, 'EMAIL_FAILED', 'send_history', `Failed sending to ${job.toEmail} (${job.historyId}): ${errorMessage}`, job.historyId);
  };

  const candidate = await getCandidate(supabase, job.candidateId);
  if (!candidate) {
    await failJob('Candidate record no longer exists.');
    message.ack();
    return;
  }
  const verification = await verifyCandidateForSending(supabase, env, candidate, { subject: job.subject, body: job.bodyText }, false);
  if (!verification.valid) {
    await failJob(`Verification blocked dispatch: ${verification.issues.join(' | ')}`);
    message.ack();
    return;
  }
  const attachmentBytes = await loadStoredPdf(supabase, env, verification.pdfFilename);
  if (!attachmentBytes) {
    await failJob(`Offer letter PDF ${verification.pdfFilename} is missing from private storage.`);
    message.ack();
    return;
  }
  const settings = await loadSettings(supabase);
  const result = await sendWorkerEmail(env, settings, {
    toEmail: candidate.email,
    toName: candidate.candidate_name,
    ccEmails: job.ccEmails,
    subject: verification.renderedSubject,
    bodyText: verification.renderedBody,
    attachmentFilename: verification.pdfFilename,
    attachmentBytes,
  });
  const maxRetries = Math.max(0, Math.min(5, Number(settings.get('max_retries') || 3) || 3));
  if (!result.success && result.retryable && attempt <= maxRetries) {
    await supabase.from('send_history').update({
      status: 'pending',
      attempts: attempt,
      provider: result.provider,
      error_message: result.errorMessage,
      updated_at: now(),
    }).eq('id', job.historyId);
    message.retry({ delaySeconds: Math.min(300, attempt * 10) });
    return;
  }
  if (!result.success) {
    await failJob(result.errorMessage || 'Email delivery failed.', result.provider);
    message.ack();
    return;
  }
  const { error: sentError } = await supabase.from('send_history').update({
    status: 'sent',
    provider: result.provider,
    provider_message_id: result.messageId,
    delivery_status: result.deliveryStatus,
    error_message: null,
    sent_at: now(),
    updated_at: now(),
  }).eq('id', job.historyId);
  if (sentError) throw new Error(`Email was accepted, but history could not be updated: ${sentError.message}`);
  await updateCampaignCounters(supabase, job.campaignId || null);
  await logWorkerActivity(supabase, 'EMAIL_SENT', 'send_history', `Sent offer letter ${verification.pdfFilename} to ${candidate.email} (Batch ${job.campaignId}) via ${result.provider}`, job.historyId);
  message.ack();
}

async function loadSettings(supabase: ReturnType<typeof createPrivilegedSupabaseClient>): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('system_settings').select('key,value');
  if (error) throw new Error(`Unable to load Supabase system_settings: ${error.message}`);
  return new Map((data ?? []).map((row) => [String(row.key), String(row.value ?? '')]));
}

async function saveSettings(supabase: ReturnType<typeof createPrivilegedSupabaseClient>, values: Record<string, string>): Promise<void> {
  const safeEntries = Object.entries(values).filter(([key]) => !secretSettingPattern.test(key));
  if (!safeEntries.length) return;
  const { error } = await supabase.from('system_settings').upsert(
    safeEntries.map(([key, value]) => ({ key, value, updated_at: now() })),
    { onConflict: 'key' },
  );
  if (error) throw new Error(`Unable to save Supabase system_settings: ${error.message}`);
}

async function invalidateCandidatePdfs(supabase: ReturnType<typeof createPrivilegedSupabaseClient>): Promise<void> {
  const { error } = await supabase.from('candidates')
    .update({ offer_generated: false, verification_status: 'unverified', verification_issues: null, updated_at: now() })
    .neq('id', 0);
  if (error) throw new Error(`Unable to invalidate candidate PDFs in Supabase: ${error.message}`);
}

function offerTemplateFromSettings(settings: Map<string, string>) {
  const defaults = DEFAULT_OFFER_LETTER_TEMPLATE;
  const get = (key: string, fallback: string) => settings.get(key) || fallback;
  const fontSize = Number(get('offer_body_font_size', String(defaults.body_font_size)));
  return {
    header_name: get('offer_header_name', defaults.header_name),
    header_role: get('offer_header_role', defaults.header_role),
    brand_title: get('offer_brand_title', defaults.brand_title),
    brand_subtitle: get('offer_brand_subtitle', defaults.brand_subtitle),
    trust_regn: get('trust_regn', defaults.trust_regn),
    trust_address: get('trust_address', defaults.trust_address),
    trust_mobile: get('trust_mobile', defaults.trust_mobile),
    trust_email: get('trust_email', defaults.trust_email),
    trust_website: get('trust_website', defaults.trust_website),
    heading: get('offer_heading', defaults.heading),
    greeting: get('offer_greeting', defaults.greeting),
    body: get('offer_body', defaults.body),
    closing: get('offer_closing', defaults.closing),
    signatory_title: get('offer_signatory_title', defaults.signatory_title),
    signatory_org: get('offer_signatory_org', defaults.signatory_org),
    contract_end_date: get('contract_end_date', defaults.contract_end_date),
    stipend_text: get('stipend_text', defaults.stipend_text),
    footer_left_url: get('offer_footer_left_url', defaults.footer_left_url),
    footer_right_url: get('offer_footer_right_url', defaults.footer_right_url),
    body_font_size: Number.isFinite(fontSize) ? Math.max(9, Math.min(12.5, Number(fontSize.toFixed(1)))) : defaults.body_font_size,
  };
}

function normalizeCampaign(row: Record<string, unknown>) {
  return {
    ...row,
    cc_emails_json: typeof row.cc_emails === 'string' ? row.cc_emails : JSON.stringify(row.cc_emails ?? []),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function deriveEmailCredentialKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('kalvi40-email-credentials-v1'),
    info: new TextEncoder().encode('smtp-password-encryption'),
  }, material, { name: 'AES-GCM', length: 256 }, false, usages);
}

async function encryptEmailCredential(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEmailCredentialKey(secret, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function decryptEmailCredential(value: string, secret: string): Promise<string> {
  const [version, ivValue, ciphertextValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue) throw new Error('Stored email credential has an unsupported format. Re-enter it in email settings.');
  const key = await deriveEmailCredentialKey(secret, ['decrypt']);
  const ivBytes = base64UrlDecode(ivValue);
  const ciphertextBytes = base64UrlDecode(ciphertextValue);
  const iv = new Uint8Array(ivBytes.byteLength);
  const ciphertext = new Uint8Array(ciphertextBytes.byteLength);
  iv.set(ivBytes);
  ciphertext.set(ciphertextBytes);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function getSmtpConfig(settings: Map<string, string>, env: Env): Promise<SmtpConfig | null> {
  const host = settings.get('smtp_host')?.trim() || 'smtp.gmail.com';
  const username = settings.get('smtp_user')?.trim() || '';
  const senderEmail = settings.get('sender_email')?.trim() || '';
  const encryptedPassword = settings.get('smtp_pass_encrypted') || '';
  let password = env.SMTP_PASS?.trim() || '';
  if (!password && encryptedPassword) password = await decryptEmailCredential(encryptedPassword, env.JWT_SECRET?.trim() || '');
  if (!host || !username || !senderEmail || !password) return null;
  return {
    host,
    port: Math.max(1, Math.min(65535, Number(settings.get('smtp_port') || 587) || 587)),
    secure: settings.get('smtp_secure') === 'true',
    username,
    password,
    senderName: settings.get('sender_name') || 'BumbleB Trust - Kalvi40',
    senderEmail,
    replyTo: settings.get('reply_to') || senderEmail,
  };
}

async function getSmtpConnector(): Promise<SmtpConnect> {
  const sockets = await import('cloudflare:sockets');
  return sockets.connect as unknown as SmtpConnect;
}

async function sendWorkerEmail(env: Env, settings: Map<string, string>, payload: SmtpPayload): Promise<SmtpResult> {
  const config = await getSmtpConfig(settings, env);
  if (!config) {
    return {
      success: false,
      provider: 'smtp',
      messageId: null,
      deliveryStatus: 'failed',
      errorMessage: 'SMTP credentials are not configured. Configure SMTP settings before sending.',
      retryable: false,
    };
  }
  return sendSmtpEmail(config, payload, await getSmtpConnector());
}

async function getFounderSignatureInfo(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  env: Env,
  settings?: Map<string, string>,
) {
  const values = settings ?? await loadSettings(supabase);
  const filename = values.get('founder_signature_filename')?.trim() || '';
  const mime = values.get('founder_signature_mime')?.trim() || 'image/png';
  const rawHeight = Number(values.get('founder_signature_height') || 40);
  const heightPt = Number.isFinite(rawHeight) ? Math.max(24, Math.min(72, Math.round(rawHeight))) : 40;
  const updatedAt = values.get('founder_signature_updated_at')?.trim() || null;
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return { hasCustomSignature: false, heightPt, updatedAt: null, dataUrl: null };
  }
  const { data, error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters').download(filename);
  if (error || !data) return { hasCustomSignature: false, heightPt, updatedAt: null, dataUrl: null };
  const bytes = new Uint8Array(await data.arrayBuffer());
  return { hasCustomSignature: true, heightPt, updatedAt, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
}

function xlsxResponse(workbook: XLSX.WorkBook, filename: string, origin?: string): Response {
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...corsHeaders(origin),
    },
  });
}

function pdfResponse(bytes: Uint8Array, filename: string, disposition: 'inline' | 'attachment', origin?: string): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      ...corsHeaders(origin),
    },
  });
}

function publicEmailConfig(settings: Map<string, string>, env: Env) {
  const passwordConfigured = Boolean(env.SMTP_PASS || settings.get('smtp_pass_encrypted'));
  const host = settings.get('smtp_host') || 'smtp.gmail.com';
  const username = settings.get('smtp_user') || '';
  const senderEmail = settings.get('sender_email') || 'prem@bumbleb.org.in';
  return {
    email_provider: 'smtp',
    sender_name: settings.get('sender_name') || 'BumbleB Trust - Kalvi40',
    sender_email: senderEmail,
    reply_to: settings.get('reply_to') || senderEmail,
    smtp_host: host,
    smtp_port: settings.get('smtp_port') || '587',
    smtp_user: username,
    smtp_pass_set: passwordConfigured,
    smtp_secure: settings.get('smtp_secure') === 'true',
    rate_limit_per_minute: Math.max(1, Number(settings.get('rate_limit_per_minute') || 45) || 45),
    max_retries: Math.max(0, Number(settings.get('max_retries') || 3) || 3),
    provider_configured: Boolean(host && username && passwordConfigured && senderEmail),
  };
}

function corsHeaders(origin?: string): Record<string, string> {
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data: unknown, status = 200, origin?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function signAdminToken(admin: { id: number; email: string; role: string }, secret: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    id: admin.id,
    email: admin.email,
    role: admin.role,
    iat: issuedAt,
    exp: issuedAt + 12 * 60 * 60,
  })));
  const unsignedToken = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsignedToken)));
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function logLoginActivity(
  supabase: ReturnType<typeof createPrivilegedSupabaseClient>,
  request: Request,
  values: { adminId?: number; adminEmail: string; action: string; details: string },
): Promise<void> {
  const forwardedFor = request.headers.get('x-forwarded-for') || '';
  const ipAddress = forwardedFor.split(',')[0].trim() || request.headers.get('cf-connecting-ip');
  const { error } = await supabase.from('activity_logs').insert({
    admin_id: values.adminId ?? null,
    admin_email: values.adminEmail,
    action: values.action,
    entity_type: 'auth',
    entity_id: values.adminId == null ? null : String(values.adminId),
    details: values.details,
    ip_address: ipAddress,
  });
  if (error) throw new Error(`Unable to write login activity to Supabase: ${error.message}`);
}

function createPrivilegedSupabaseClient(env: Env, fetchImpl?: typeof fetch) {
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !secretKey) {
    throw new Error('Privileged Supabase configuration is not available.');
  }
  return createClient(env.SUPABASE_URL, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

type SupabaseProbeDetail = 'configured' | 'missing_configuration' | 'api_error' | 'transport_error' | 'table_missing' | 'permission_denied' | 'api_key_rejected' | 'supabase_server_error';

function sanitizeDiagnosticMessage(message: unknown): string | undefined {
  if (typeof message !== 'string' || !message.trim()) return undefined;
  return message
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/gi, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .slice(0, 240);
}

function categorizeSupabaseProbeError(status: number | undefined, code: string | undefined, message?: string): SupabaseProbeDetail {
  if (code === 'PGRST205' || status === 404) return 'table_missing';
  if (/forbidden use of secret api key|invalid api key|api key.*invalid/i.test(message || '')) return 'api_key_rejected';
  if (code === '42501' || status === 403 || (status === 401 && code)) return 'permission_denied';
  if (status === 401) return 'api_key_rejected';
  if (status !== undefined && status >= 500) return 'supabase_server_error';
  if (status === undefined && !code) return 'transport_error';
  return 'api_error';
}

async function probeSupabaseDatabase(env: Env): Promise<{
  reachable: boolean;
  database: 'connected' | 'verification_pending';
  detail: SupabaseProbeDetail;
  status?: number;
  code?: string;
  diagnostic?: string;
}> {
  const serviceKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !serviceKey) {
    console.warn(JSON.stringify({
      event: 'supabase_health_probe',
      category: 'missing_configuration',
      hasSupabaseUrl: Boolean(env.SUPABASE_URL),
      hasPrivilegedSupabaseKey: Boolean(serviceKey),
    }));
    return { reachable: false, database: 'verification_pending', detail: 'missing_configuration' };
  }

  try {
    // The existing schema intentionally does not grant anon SELECT on candidates.
    // Probe with the same server-only role used by the Express backend; never log the key.
    let responseStatus: number | undefined;
    const fetchWithStatus: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      responseStatus = response.status;
      return response;
    };
    const supabase = createPrivilegedSupabaseClient(env, fetchWithStatus);
    const { error } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    if (!error) {
      console.info(JSON.stringify({
        event: 'supabase_health_probe',
        category: 'configured',
        status: responseStatus ?? 200,
        code: null,
      }));
      return { reachable: true, database: 'connected', detail: 'configured' };
    }

    const status = responseStatus;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const diagnostic = sanitizeDiagnosticMessage(error.message);
    const detail = categorizeSupabaseProbeError(status, code, diagnostic);
    console.warn(JSON.stringify({
      event: 'supabase_health_probe',
      category: detail,
      status: status ?? null,
      code: code ?? null,
      diagnostic: diagnostic ?? null,
    }));
    return {
      reachable: true,
      database: 'verification_pending',
      detail,
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(diagnostic ? { diagnostic } : {}),
    };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    const diagnostic = sanitizeDiagnosticMessage(error instanceof Error ? error.message : undefined);
    const detail = categorizeSupabaseProbeError(status, code, diagnostic);
    console.warn(JSON.stringify({
      event: 'supabase_health_probe',
      category: detail,
      status: status ?? null,
      code: code ?? null,
      diagnostic: diagnostic ?? null,
    }));
    return {
      reachable: false,
      database: 'verification_pending',
      detail,
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${headerB64}.${payloadB64}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestOrigin = request.headers.get('Origin') || undefined;
    const allowedOrigins = (env.ALLOWED_ORIGIN || 'https://offerletter-kalvi40.pages.dev')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
      return new Response('Origin is not allowed.', { status: 403, headers: { Vary: 'Origin' } });
    }
    const origin = requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', runtime: 'cloudflare-workers' }, 200, origin);
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      let body: { email?: unknown; password?: unknown };
      try {
        body = await request.json() as { email?: unknown; password?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }

      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return jsonResponse({ error: 'Email and password are required.' }, 400, origin);
      }

      const jwtSecret = env.JWT_SECRET?.trim();
      if (!jwtSecret) {
        return jsonResponse({ error: 'JWT_SECRET is not configured for this Worker.' }, 503, origin);
      }

      let supabase: ReturnType<typeof createPrivilegedSupabaseClient>;
      try {
        supabase = createPrivilegedSupabaseClient(env);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase configuration is missing.' }, 503, origin);
      }

      const { data: row, error } = await supabase.from('admins').select('*').eq('email', email).maybeSingle();
      if (error) {
        return jsonResponse({ error: `Unable to authenticate against Supabase: ${error.message}` }, 503, origin);
      }

      const validPassword = row?.password_hash ? await bcrypt.compare(password, row.password_hash) : false;
      if (!row || !validPassword) {
        await logLoginActivity(supabase, request, {
          adminEmail: email || 'unknown',
          action: 'AUTH_LOGIN_FAILED',
          details: `Failed sign-in attempt for ${email}`,
        });
        return jsonResponse({ error: 'Invalid email address or password.' }, 401, origin);
      }

      const timestamp = new Date().toISOString();
      const { error: updateError } = await supabase.from('admins')
        .update({ last_login_at: timestamp, updated_at: timestamp })
        .eq('id', row.id);
      if (updateError) {
        return jsonResponse({ error: `Unable to update administrator login time: ${updateError.message}` }, 503, origin);
      }

      const admin = {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        designation: row.designation,
        phone: row.phone,
        last_login_at: timestamp,
        created_at: row.created_at,
      };
      await logLoginActivity(supabase, request, {
        adminId: admin.id,
        adminEmail: email,
        action: 'AUTH_LOGIN',
        details: `Administrator ${admin.name} signed in.`,
      });

      return jsonResponse({ token: await signAdminToken(admin, jwtSecret), admin }, 200, origin);
    }

    if (url.pathname === '/api/auth/forgot-password' && request.method === 'POST') {
      let body: { email?: unknown };
      try {
        body = await request.json() as { email?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return jsonResponse({ error: 'Email address is required.' }, 400, origin);
      let supabase: ReturnType<typeof createPrivilegedSupabaseClient>;
      try {
        supabase = createPrivilegedSupabaseClient(env);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase configuration is missing.' }, 503, origin);
      }
      const { data: admin, error } = await supabase.from('admins').select('id,name,email').eq('email', email).maybeSingle();
      if (error) return jsonResponse({ error: `Unable to look up administrator in Supabase: ${error.message}` }, 503, origin);
      if (!admin) return jsonResponse({ message: 'If an administrator account matches that email, a password reset token has been generated.' }, 200, origin);
      const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
      const resetToken = [...tokenBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { error: insertError } = await supabase.from('password_resets').insert({ admin_id: admin.id, token: resetToken, expires_at: expiresAt });
      if (insertError) return jsonResponse({ error: `Unable to create Supabase password reset: ${insertError.message}` }, 503, origin);
      try {
        await logLoginActivity(supabase, request, {
          adminId: Number(admin.id),
          adminEmail: email,
          action: 'AUTH_RESET_REQUESTED',
          details: `Password reset requested for ${email}`,
        });
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({
        message: 'Email provider is not yet configured; use the secure one-time reset token below to complete your reset.',
        emailed: false,
        resetToken,
      }, 200, origin);
    }

    if (url.pathname === '/api/auth/reset-password' && request.method === 'POST') {
      let body: { token?: unknown; newPassword?: unknown };
      try {
        body = await request.json() as { token?: unknown; newPassword?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const resetToken = String(body.token || '').trim();
      const newPassword = String(body.newPassword || '');
      if (!resetToken || newPassword.length < 8) return jsonResponse({ error: 'Valid reset token and a new password (minimum 8 characters) are required.' }, 400, origin);
      let supabase: ReturnType<typeof createPrivilegedSupabaseClient>;
      try {
        supabase = createPrivilegedSupabaseClient(env);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase configuration is missing.' }, 503, origin);
      }
      const { data: reset, error } = await supabase.from('password_resets').select('*').eq('token', resetToken).is('used_at', null).maybeSingle();
      if (error) return jsonResponse({ error: `Unable to validate reset token: ${error.message}` }, 503, origin);
      if (!reset || new Date(reset.expires_at).getTime() < Date.now()) return jsonResponse({ error: 'Reset token is invalid or has expired.' }, 400, origin);
      const { data: admin, error: adminError } = await supabase.from('admins').select('email').eq('id', reset.admin_id).maybeSingle();
      if (adminError || !admin) return jsonResponse({ error: 'Unable to load administrator for password reset.' }, 503, origin);
      const timestamp = now();
      const { error: updateError } = await supabase.from('admins')
        .update({ password_hash: bcrypt.hashSync(newPassword, 10), updated_at: timestamp }).eq('id', reset.admin_id);
      if (updateError) return jsonResponse({ error: `Unable to update administrator password: ${updateError.message}` }, 503, origin);
      const { error: usedError } = await supabase.from('password_resets').update({ used_at: timestamp }).eq('id', reset.id);
      if (usedError) return jsonResponse({ error: `Password changed but reset token could not be marked used: ${usedError.message}` }, 503, origin);
      try {
        await logLoginActivity(supabase, request, {
          adminId: Number(reset.admin_id),
          adminEmail: String(admin.email),
          action: 'AUTH_PASSWORD_RESET',
          details: 'Administrator password reset completed.',
        });
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ message: 'Password updated successfully. You may now sign in.' }, 200, origin);
    }

    if (url.pathname === '/api/health/supabase' && request.method === 'GET') {
      const probe = await probeSupabaseDatabase(env);
      if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
        return jsonResponse({
          success: false,
          database: 'verification_pending',
          provider: 'supabase',
          reason: probe.detail,
        }, 503, origin);
      }
      if (probe.database === 'connected') {
        return jsonResponse({ success: true, database: 'connected', provider: 'supabase' }, 200, origin);
      }
      return jsonResponse({
        success: false,
        database: 'verification_pending',
        provider: 'supabase',
        reason: probe.detail,
        ...(probe.status === undefined ? {} : { status: probe.status }),
        ...(probe.code === undefined ? {} : { code: probe.code }),
        ...(probe.diagnostic === undefined ? {} : { diagnostic: probe.diagnostic }),
      }, 503, origin);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : url.searchParams.get('token') || '';
    const session = token ? await verifyJwt(token, env.JWT_SECRET) : null;
    if (!session) {
      return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    }

    // The application JWT is verified above and is not a Supabase Auth JWT.
    // Use the server-only role for the authorized data queries instead of
    // forwarding the app token as Supabase's Authorization bearer token.
    let supabase: ReturnType<typeof createPrivilegedSupabaseClient>;
    try {
      supabase = createPrivilegedSupabaseClient(env);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase configuration is missing.' }, 503, origin);
    }

    if (url.pathname === '/api/dashboard' && request.method === 'GET') {
      const [candidatesRes, historyRes, logsRes, campaignsRes] = await Promise.all([
        supabase.from('candidates').select('id,district,offer_generated,created_at'),
        supabase.from('send_history').select('status,created_at'),
        supabase.from('activity_logs').select('*').order('id', { ascending: false }).limit(10),
        supabase.from('campaigns').select('*').order('id', { ascending: false }).limit(6),
      ]);
      const queryError = candidatesRes.error || historyRes.error || logsRes.error || campaignsRes.error;
      if (queryError) return jsonResponse({ error: queryError.message }, 503, origin);

      const candidates = candidatesRes.data ?? [];
      const history = historyRes.data ?? [];
      const monthly = new Map<string, { month: string; sent: number; failed: number; pending: number }>();
      for (const item of history) {
        const month = String(item.created_at || '').slice(0, 7);
        if (!month) continue;
        const entry = monthly.get(month) ?? { month, sent: 0, failed: 0, pending: 0 };
        if (item.status === 'sent') entry.sent += 1;
        else if (item.status === 'failed') entry.failed += 1;
        else entry.pending += 1;
        monthly.set(month, entry);
      }

      const districts = new Map<string, { district: string; count: number; offers_generated: number }>();
      for (const candidate of candidates) {
        const district = candidate.district || '';
        const entry = districts.get(district) ?? { district, count: 0, offers_generated: 0 };
        entry.count += 1;
        if (candidate.offer_generated) entry.offers_generated += 1;
        districts.set(district, entry);
      }

      return jsonResponse({
        kpis: {
          totalCandidates: candidates.length,
          totalOffersGenerated: candidates.filter((candidate) => candidate.offer_generated).length,
          emailsSent: history.filter((item) => item.status === 'sent').length,
          emailsPending: history.filter((item) => item.status === 'pending' || item.status === 'processing').length,
          emailsFailed: history.filter((item) => item.status === 'failed').length,
        },
        districtDistribution: [...districts.values()].sort((a, b) => b.count - a.count).slice(0, 12),
        monthlyActivity: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12),
        recentActivities: logsRes.data ?? [],
        recentCampaigns: (campaignsRes.data ?? []).map((campaign) => ({
          ...campaign,
          cc_emails_json: typeof campaign.cc_emails === 'string' ? campaign.cc_emails : JSON.stringify(campaign.cc_emails ?? []),
        })),
        providerConfigured: false,
      }, 200, origin);
    }

    if (url.pathname === '/api/candidates' && request.method === 'GET') {
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const district = (url.searchParams.get('district') || '').trim();
      const offerStatus = url.searchParams.get('offerStatus') || '';
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const pageSize = Math.min(200, Math.max(5, Number(url.searchParams.get('pageSize') || 15)));
      const showAll = url.searchParams.get('all') === 'true';
      const sortableColumns = ['id', 'candidate_name', 'school_name', 'district', 'joining_date', 'created_at'] as const;
      const requestedSort = url.searchParams.get('sortBy') || 'id';
      const sortBy = sortableColumns.includes(requestedSort as typeof sortableColumns[number]) ? requestedSort : 'id';
      const ascending = (url.searchParams.get('sortDir') || 'desc').toLowerCase() === 'asc';

      const [{ data, error }, { data: history, error: historyError }] = await Promise.all([
        supabase.from('candidates').select('*'),
        supabase.from('send_history').select('candidate_id,status,id').order('id', { ascending: false }),
      ]);
      if (error || historyError) return jsonResponse({ error: error?.message || historyError?.message || 'Unable to load candidates.' }, 503, origin);

      const lastStatusByCandidate = new Map<number, string>();
      for (const entry of history ?? []) {
        if (!lastStatusByCandidate.has(Number(entry.candidate_id))) {
          lastStatusByCandidate.set(Number(entry.candidate_id), entry.status);
        }
      }

      let candidates = (data ?? []).map((candidate) => ({
        ...candidate,
        offer_generated: candidate.offer_generated ? 1 : 0,
        verification_issues: candidate.verification_issues == null
          ? null
          : typeof candidate.verification_issues === 'string'
            ? candidate.verification_issues
            : JSON.stringify(candidate.verification_issues),
        last_send_status: lastStatusByCandidate.get(Number(candidate.id)) ?? null,
      }));
      const districts = [...new Set(candidates.map((candidate) => candidate.district))].sort();

      if (search) {
        candidates = candidates.filter((candidate) =>
          [candidate.candidate_name, candidate.school_name, candidate.location, candidate.district, candidate.phone, candidate.email]
            .some((value) => String(value || '').toLowerCase().includes(search)),
        );
      }
      if (district && district !== 'all') candidates = candidates.filter((candidate) => candidate.district === district);
      if (offerStatus === 'generated') candidates = candidates.filter((candidate) => Boolean(candidate.offer_generated));
      if (offerStatus === 'pending') candidates = candidates.filter((candidate) => !candidate.offer_generated);

      candidates.sort((left, right) => {
        const leftValue = left[sortBy as keyof typeof left];
        const rightValue = right[sortBy as keyof typeof right];
        const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
        return ascending ? comparison : -comparison;
      });

      const total = candidates.length;
      if (!showAll) candidates = candidates.slice((page - 1) * pageSize, page * pageSize);
      return jsonResponse({ items: candidates, total, page, pageSize, districts }, 200, origin);
    }

    const candidateMatch = url.pathname.match(/^\/api\/candidates\/(\d+)$/);
    if (candidateMatch && request.method === 'GET') {
      const candidateId = Number(candidateMatch[1]);
      const [candidateRes, historyRes] = await Promise.all([
        supabase.from('candidates').select('*').eq('id', candidateId).maybeSingle(),
        supabase.from('send_history').select('status').eq('candidate_id', candidateId).order('id', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (candidateRes.error || historyRes.error) return jsonResponse({ error: candidateRes.error?.message || historyRes.error?.message }, 503, origin);
      if (!candidateRes.data) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      return jsonResponse({ candidate: normalizeCandidate({ ...candidateRes.data, last_send_status: historyRes.data?.status ?? null }) }, 200, origin);
    }

    if (url.pathname === '/api/candidates' && request.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const candidate = {
        candidate_name: String(body.candidate_name || '').trim(),
        school_name: normalizeSchoolName(String(body.school_name || '')),
        location: String(body.location || '').trim(),
        district: String(body.district || '').trim(),
        phone: String(body.phone || '').trim(),
        email: String(body.email || '').trim().toLowerCase(),
        joining_date: formatDateDDMMYYYY(String(body.joining_date || '').trim()),
        custom_offer_body: typeof body.custom_offer_body === 'string' && body.custom_offer_body.trim() ? body.custom_offer_body.trim() : null,
      };
      if (!candidate.candidate_name || !candidate.school_name || !candidate.location || !candidate.district || !candidate.phone || !candidate.email || !candidate.joining_date) {
        return jsonResponse({ error: 'All 7 candidate fields are required.' }, 400, origin);
      }
      if (!validEmail(candidate.email)) return jsonResponse({ error: 'Please provide a valid candidate email address.' }, 400, origin);

      const { data: duplicate, error: duplicateError } = await supabase.from('candidates')
        .select('id,candidate_name').eq('email', candidate.email).maybeSingle();
      if (duplicateError) return jsonResponse({ error: duplicateError.message }, 503, origin);
      if (duplicate) return jsonResponse({ error: `Duplicate email detected: "${candidate.email}" is already assigned to ${duplicate.candidate_name}.` }, 409, origin);

      const { data, error } = await supabase.from('candidates').insert(candidate).select('*').single();
      if (error) return jsonResponse({ error: `Unable to create candidate in Supabase: ${error.message}` }, 503, origin);
      const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('cf-connecting-ip');
      const { error: logError } = await supabase.from('activity_logs').insert({
        admin_id: Number(session.id),
        admin_email: String(session.email || 'unknown'),
        action: 'CANDIDATE_CREATED',
        entity_type: 'candidate',
        entity_id: String(data.id),
        details: `Added candidate ${data.candidate_name} (${data.email}) for ${data.school_name}, ${data.district}`,
        ip_address: ipAddress,
      });
      if (logError) return jsonResponse({ error: `Candidate was created but activity logging failed: ${logError.message}` }, 503, origin);
      return jsonResponse({ candidate: normalizeCandidate(data) }, 201, origin);
    }

    if (candidateMatch && request.method === 'PUT') {
      const candidateId = Number(candidateMatch[1]);
      const { data: existing, error: existingError } = await supabase.from('candidates').select('*').eq('id', candidateId).maybeSingle();
      if (existingError) return jsonResponse({ error: existingError.message }, 503, origin);
      if (!existing) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const email = String(body.email || '').trim().toLowerCase();
      const patch = {
        candidate_name: String(body.candidate_name || '').trim(),
        school_name: normalizeSchoolName(String(body.school_name || '')),
        location: String(body.location || '').trim(),
        district: String(body.district || '').trim(),
        phone: String(body.phone || '').trim(),
        email,
        joining_date: formatDateDDMMYYYY(String(body.joining_date || '').trim()),
        custom_offer_body: Object.prototype.hasOwnProperty.call(body, 'custom_offer_body')
          ? typeof body.custom_offer_body === 'string' && body.custom_offer_body.trim() ? body.custom_offer_body.trim() : null
          : existing.custom_offer_body ?? null,
        offer_generated: false,
        verification_status: 'unverified',
        verification_issues: null,
        updated_at: now(),
      };
      if (!patch.candidate_name || !patch.school_name || !patch.location || !patch.district || !email || !patch.joining_date) {
        return jsonResponse({ error: 'All 6 candidate fields are required.' }, 400, origin);
      }
      if (!validEmail(email)) return jsonResponse({ error: 'Invalid email address format.' }, 400, origin);
      const { data: duplicate, error: duplicateError } = await supabase.from('candidates')
        .select('id,candidate_name').eq('email', email).neq('id', candidateId).maybeSingle();
      if (duplicateError) return jsonResponse({ error: duplicateError.message }, 503, origin);
      if (duplicate) return jsonResponse({ error: `Duplicate email detected: "${email}" belongs to ${duplicate.candidate_name}.` }, 409, origin);
      const { data, error } = await supabase.from('candidates').update(patch).eq('id', candidateId).select('*').maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      if (!data) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      const updated = normalizeCandidate(data);
      try {
        await recordAdminActivity(supabase, request, session, 'CANDIDATE_UPDATED', 'candidate',
          `Updated candidate ${patch.candidate_name} (${patch.email}); PDF regeneration queued on next preview/send.`, candidateId);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ candidate: updated }, 200, origin);
    }

    if (url.pathname === '/api/candidates/bulk-delete' && request.method === 'POST') {
      let body: { deleteAll?: unknown; candidateIds?: unknown };
      try {
        body = await request.json() as { deleteAll?: unknown; candidateIds?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const deleteAll = Boolean(body.deleteAll);
      const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.map(Number).filter(Number.isFinite) : [];
      if (!deleteAll && !candidateIds.length) return jsonResponse({ error: 'Select candidates to delete or specify deleteAll.' }, 400, origin);
      let readQuery = supabase.from('candidates').select('id,candidate_name,offer_filename');
      if (!deleteAll) readQuery = readQuery.in('id', candidateIds);
      const { data: targets, error: readError } = await readQuery;
      if (readError) return jsonResponse({ error: readError.message }, 503, origin);
      if (!targets?.length) return jsonResponse({ deletedCount: 0, message: 'No candidates to delete.' }, 200, origin);
      let deleteQuery = supabase.from('candidates').delete();
      deleteQuery = deleteAll ? deleteQuery.not('id', 'is', null) : deleteQuery.in('id', targets.map((row) => row.id));
      const { error: deleteError } = await deleteQuery;
      if (deleteError) return jsonResponse({ error: deleteError.message }, 503, origin);
      await deleteCandidateFiles(supabase, env, targets);
      const count = targets.length;
      try {
        await recordAdminActivity(supabase, request, session, deleteAll ? 'CANDIDATES_CLEARED' : 'CANDIDATES_BULK_DELETED', 'candidate',
          `Removed ${count} candidate record(s)${deleteAll ? ' (cleared directory)' : ''}.`);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ deletedCount: count, message: `Removed ${count} candidate(s).` }, 200, origin);
    }

    if (url.pathname === '/api/candidates/bulk-import' && request.method === 'POST') {
      let body: { records?: unknown; skipDuplicates?: unknown };
      try {
        body = await request.json() as { records?: unknown; skipDuplicates?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const records = Array.isArray(body.records) ? body.records as Array<Record<string, unknown>> : [];
      const skipDuplicates = body.skipDuplicates !== false;
      if (!records.length) return jsonResponse({ error: 'No candidate records supplied for import.' }, 400, origin);
      const skipped: Array<{ email: string; reason: string }> = [];
      const valid: Array<{ candidate: Record<string, string>; existing: boolean }> = [];
      for (const raw of records) {
        const candidate = {
          candidate_name: String(raw?.candidate_name || '').trim(),
          school_name: normalizeSchoolName(String(raw?.school_name || '')),
          location: String(raw?.location || '').trim(),
          district: String(raw?.district || '').trim(),
          phone: String(raw?.phone || '').trim(),
          email: String(raw?.email || '').trim().toLowerCase(),
          joining_date: formatDateDDMMYYYY(String(raw?.joining_date || '').trim()),
        };
        if (!candidate.candidate_name || !candidate.school_name || !candidate.location || !candidate.district || !candidate.phone || !candidate.email || !candidate.joining_date) {
          skipped.push({ email: candidate.email || '(blank)', reason: 'Missing required fields' });
          continue;
        }
        if (!validEmail(candidate.email)) {
          skipped.push({ email: candidate.email, reason: 'Invalid email format' });
          continue;
        }
        const { data: existing, error } = await supabase.from('candidates').select('id').eq('email', candidate.email).maybeSingle();
        if (error) return jsonResponse({ error: error.message }, 503, origin);
        if (existing && skipDuplicates) {
          skipped.push({ email: candidate.email, reason: 'Duplicate email already exists in database' });
          continue;
        }
        valid.push({ candidate, existing: Boolean(existing) });
      }
      const recordsToWrite = valid.filter((entry) => !entry.existing || !skipDuplicates).map((entry) => entry.candidate);
      let importedIds: number[] = [];
      if (recordsToWrite.length) {
        const { data, error } = await supabase.rpc('kalvi40_bulk_upsert_candidates', { p_candidates: recordsToWrite });
        if (error) return jsonResponse({ error: `Atomic Supabase bulk import failed: ${error.message}` }, 503, origin);
        importedIds = (data ?? []).map((row: unknown) => Number(typeof row === 'number' ? row : row && typeof row === 'object' ? (row as Record<string, unknown>).kalvi40_bulk_upsert_candidates ?? Object.values(row)[0] : NaN)).filter(Number.isFinite);
      }
      try {
        await recordAdminActivity(supabase, request, session, 'BULK_IMPORT', 'candidate',
          `Imported ${importedIds.length} candidate(s); skipped ${skipped.length} duplicate/invalid row(s).`);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ importedCount: importedIds.length, skippedCount: skipped.length, skipped, importedIds }, 201, origin);
    }

    if (candidateMatch && request.method === 'DELETE') {
      const candidateId = Number(candidateMatch[1]);
      const { data: candidate, error: lookupError } = await supabase.from('candidates').select('*').eq('id', candidateId).maybeSingle();
      if (lookupError) return jsonResponse({ error: lookupError.message }, 503, origin);
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      const { error } = await supabase.from('candidates').delete().eq('id', candidateId);
      if (error) return jsonResponse({ error: `Unable to delete candidate from Supabase: ${error.message}` }, 503, origin);
      await deleteCandidateFiles(supabase, env, [candidate]);
      try {
        await recordAdminActivity(supabase, request, session, 'CANDIDATE_DELETED', 'candidate',
          `Deleted candidate ${candidate.candidate_name} (${candidate.email})`, candidateId);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ message: 'Candidate deleted.' }, 200, origin);
    }

    const candidateContentMatch = url.pathname.match(/^\/api\/candidates\/(\d+)\/offer-content$/);
    if (candidateContentMatch && request.method === 'PUT') {
      const candidateId = Number(candidateContentMatch[1]);
      const candidate = await getCandidate(supabase, candidateId);
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      let body: { custom_offer_body?: unknown };
      try {
        body = await request.json() as { custom_offer_body?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const customOfferBody = typeof body.custom_offer_body === 'string' ? body.custom_offer_body.trim() || null : null;
      const { error } = await supabase.from('candidates').update({
        custom_offer_body: customOfferBody,
        offer_generated: false,
        verification_status: 'unverified',
        verification_issues: null,
        updated_at: now(),
      }).eq('id', candidateId);
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        const updatedCandidate = await getCandidate(supabase, candidateId);
        if (!updatedCandidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
        const pdf = await generateAndStorePdf(supabase, env, updatedCandidate);
        const refreshed = await getCandidate(supabase, candidateId);
        await recordAdminActivity(supabase, request, session, 'CANDIDATE_OFFER_CONTENT_UPDATED', 'candidate',
          `Saved offer content and regenerated ${pdf.filename} for ${candidate.candidate_name}.`, candidateId);
        return jsonResponse({ candidate: refreshed, filename: pdf.filename }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to save candidate offer content.' }, 503, origin);
      }
    }

    const generatePdfMatch = url.pathname.match(/^\/api\/candidates\/(\d+)\/generate-pdf$/);
    if (generatePdfMatch && request.method === 'POST') {
      const candidateId = Number(generatePdfMatch[1]);
      const candidate = await getCandidate(supabase, candidateId);
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      try {
        const result = await generateAndStorePdf(supabase, env, candidate);
        const updated = await getCandidate(supabase, candidateId);
        await recordAdminActivity(supabase, request, session, 'PDF_GENERATED', 'candidate', `Generated offer letter PDF ${result.filename} for ${candidate.candidate_name}`, candidateId);
        return jsonResponse({ filename: result.filename, sizeBytes: result.bytes.length, candidate: updated }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to generate offer letter PDF.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/candidates/bulk-generate-pdfs' && request.method === 'POST') {
      let body: { candidateIds?: unknown };
      try {
        body = await request.json() as { candidateIds?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(Number) : [];
      const { data, error } = await supabase.from('candidates').select('*').order('id', { ascending: true });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      const candidates = (data ?? []).filter((candidate) => !ids.length || ids.includes(Number(candidate.id)));
      if (!candidates.length) return jsonResponse({ error: 'No candidates selected for PDF generation.' }, 400, origin);
      const generated: Array<{ id: number; name: string; filename: string }> = [];
      try {
        for (const candidate of candidates) {
          const result = await generateAndStorePdf(supabase, env, candidate);
          generated.push({ id: Number(candidate.id), name: String(candidate.candidate_name), filename: result.filename });
        }
        await recordAdminActivity(supabase, request, session, 'BULK_PDF_GENERATED', 'candidate', `Generated ${generated.length} personalized offer letter PDFs.`);
        return jsonResponse({ generatedCount: generated.length, files: generated }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to generate selected offer PDFs.' }, 503, origin);
      }
    }

    const candidatePdfMatch = url.pathname.match(/^\/api\/candidates\/(\d+)\/pdf$/);
    if (candidatePdfMatch && request.method === 'GET') {
      const candidateId = Number(candidatePdfMatch[1]);
      const candidate = await getCandidate(supabase, candidateId);
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      const filename = sanitizeOfferFilename(String(candidate.candidate_name || 'Candidate'));
      let bytes = url.searchParams.get('refresh') === '1' || !candidate.offer_generated
        ? null
        : await loadStoredPdf(supabase, env, filename);
      try {
        if (!bytes) bytes = (await generateAndStorePdf(supabase, env, candidate)).bytes;
        return pdfResponse(bytes, filename, url.searchParams.get('download') === '1' ? 'attachment' : 'inline', origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load offer letter PDF.' }, 503, origin);
      }
    }

    const candidateVerifyMatch = url.pathname.match(/^\/api\/candidates\/(\d+)\/verify$/);
    if (candidateVerifyMatch && request.method === 'GET') {
      const candidate = await getCandidate(supabase, Number(candidateVerifyMatch[1]));
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      try {
        return jsonResponse(await verifyCandidateForSending(supabase, env, candidate, undefined, true), 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to verify candidate.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/candidates/verify-batch' && request.method === 'POST') {
      let body: { candidateIds?: unknown; subject?: unknown; body?: unknown };
      try {
        body = await request.json() as { candidateIds?: unknown; subject?: unknown; body?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const ids = Array.isArray(body.candidateIds) ? body.candidateIds.map(Number) : [];
      if (!ids.length) return jsonResponse({ error: 'Select at least one candidate to verify.' }, 400, origin);
      const { data, error } = await supabase.from('candidates').select('*').order('id', { ascending: true });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      const candidates = (data ?? []).filter((candidate) => ids.includes(Number(candidate.id)));
      const override = body.subject && body.body ? { subject: String(body.subject), body: String(body.body) } : undefined;
      const results = [];
      try {
        for (const candidate of candidates) results.push({ candidate: normalizeCandidate(candidate), verification: await verifyCandidateForSending(supabase, env, candidate, override, true) });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to verify candidates.' }, 503, origin);
      }
      const validCount = results.filter((result) => result.verification.valid).length;
      return jsonResponse({ total: results.length, validCount, invalidCount: results.length - validCount, results }, 200, origin);
    }

    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const { data: admin, error } = await supabase.from('admins')
        .select('id,name,email,role,designation,phone,last_login_at,created_at')
        .eq('id', Number(session.id))
        .maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      if (!admin) return jsonResponse({ error: 'Administrator session is invalid or expired.' }, 401, origin);
      return jsonResponse({ admin }, 200, origin);
    }

    if (url.pathname === '/api/auth/profile' && request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const adminId = Number(session.id);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const designation = String(body.designation || '').trim();
      const phone = String(body.phone || '').trim();
      if (!name || !email) return jsonResponse({ error: 'Name and email are required.' }, 400, origin);
      const { data: conflict, error: conflictError } = await supabase.from('admins')
        .select('id').eq('email', email).neq('id', adminId).maybeSingle();
      if (conflictError) return jsonResponse({ error: conflictError.message }, 503, origin);
      if (conflict) return jsonResponse({ error: 'Another administrator already uses this email.' }, 409, origin);
      const { data, error } = await supabase.from('admins')
        .update({ name, email, designation, phone, updated_at: now() })
        .eq('id', adminId)
        .select('id,name,email,role,designation,phone,last_login_at,created_at')
        .single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'PROFILE_UPDATED', 'admin', `Updated administrator profile (${name})`, adminId);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ admin: data }, 200, origin);
    }

    if (url.pathname === '/api/auth/password' && request.method === 'PUT') {
      let body: { currentPassword?: unknown; newPassword?: unknown };
      try {
        body = await request.json() as { currentPassword?: unknown; newPassword?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!currentPassword || newPassword.length < 8) return jsonResponse({ error: 'Current password and a new password of at least 8 characters are required.' }, 400, origin);
      const { data: row, error } = await supabase.from('admins').select('password_hash').eq('id', Number(session.id)).single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      if (!bcrypt.compareSync(currentPassword, row.password_hash)) return jsonResponse({ error: 'Current password is incorrect.' }, 400, origin);
      const { error: updateError } = await supabase.from('admins')
        .update({ password_hash: bcrypt.hashSync(newPassword, 10), updated_at: now() }).eq('id', Number(session.id));
      if (updateError) return jsonResponse({ error: updateError.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'PASSWORD_CHANGED', 'admin', 'Administrator password updated.', Number(session.id));
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ message: 'Password updated successfully.' }, 200, origin);
    }

    if (url.pathname === '/api/reports' && request.method === 'GET') {
      const [candidatesRes, historyRes, campaignsRes] = await Promise.all([
        supabase.from('candidates').select('*'),
        supabase.from('send_history').select('*'),
        supabase.from('campaigns').select('*').order('id', { ascending: false }).limit(25),
      ]);
      const queryError = candidatesRes.error || historyRes.error || campaignsRes.error;
      if (queryError) return jsonResponse({ error: queryError.message }, 503, origin);
      const candidates = candidatesRes.data ?? [];
      const history = historyRes.data ?? [];
      const sentEmails = history.filter((row) => row.status === 'sent').length;
      const failedEmails = history.filter((row) => row.status === 'failed').length;
      const pendingEmails = history.filter((row) => row.status === 'pending' || row.status === 'processing').length;
      const historyByCandidate = new Map<number, typeof history>();
      for (const row of history) {
        const key = Number(row.candidate_id);
        const items = historyByCandidate.get(key) ?? [];
        items.push(row);
        historyByCandidate.set(key, items);
      }
      const districtGroups = new Map<string, { district: string; candidates: number; offers_generated: number; emails_sent: number; emails_failed: number }>();
      const schoolGroups = new Map<string, { school_name: string; location: string; district: string; candidates: number; offers_generated: number; emails_sent: number }>();
      const monthlyGroups = new Map<string, { month: string; candidates_added: number; offers_generated: number }>();
      for (const candidate of candidates) {
        const district = candidate.district || '';
        const districtRow = districtGroups.get(district) ?? { district, candidates: 0, offers_generated: 0, emails_sent: 0, emails_failed: 0 };
        districtRow.candidates += 1;
        if (candidate.offer_generated) districtRow.offers_generated += 1;
        const candidateHistory = historyByCandidate.get(Number(candidate.id)) ?? [];
        if (candidateHistory.some((row) => row.status === 'sent')) districtRow.emails_sent += 1;
        if (candidateHistory.some((row) => row.status === 'failed')) districtRow.emails_failed += 1;
        districtGroups.set(district, districtRow);

        const schoolName = candidate.school_name || '';
        const location = candidate.location || '';
        const schoolKey = JSON.stringify([schoolName, location, district]);
        const schoolRow = schoolGroups.get(schoolKey) ?? { school_name: schoolName, location, district, candidates: 0, offers_generated: 0, emails_sent: 0 };
        schoolRow.candidates += 1;
        if (candidate.offer_generated) schoolRow.offers_generated += 1;
        if (candidateHistory.some((row) => row.status === 'sent')) schoolRow.emails_sent += 1;
        schoolGroups.set(schoolKey, schoolRow);

        const month = String(candidate.created_at || '').slice(0, 7);
        if (month) {
          const monthRow = monthlyGroups.get(month) ?? { month, candidates_added: 0, offers_generated: 0 };
          monthRow.candidates_added += 1;
          if (candidate.offer_generated) monthRow.offers_generated += 1;
          monthlyGroups.set(month, monthRow);
        }
      }
      const totalOffers = candidates.filter((candidate) => candidate.offer_generated).length;
      return jsonResponse({
        summary: {
          totalCandidates: candidates.length,
          totalOffers,
          sentEmails,
          failedEmails,
          pendingEmails,
          successRate: sentEmails + failedEmails ? Number((sentEmails / (sentEmails + failedEmails) * 100).toFixed(1)) : 0,
        },
        districtReports: [...districtGroups.values()].sort((a, b) => b.candidates - a.candidates),
        schoolReports: [...schoolGroups.values()].sort((a, b) => b.candidates - a.candidates || a.school_name.localeCompare(b.school_name)),
        monthlyTrends: [...monthlyGroups.values()].sort((a, b) => a.month.localeCompare(b.month)),
        campaignPerformance: (campaignsRes.data ?? []).map(normalizeCampaign),
      }, 200, origin);
    }

    if (url.pathname === '/api/reports/export' && request.method === 'GET') {
      const [candidatesRes, historyRes] = await Promise.all([
        supabase.from('candidates').select('*').order('id', { ascending: false }),
        supabase.from('send_history').select('*').order('id', { ascending: false }),
      ]);
      const queryError = candidatesRes.error || historyRes.error;
      if (queryError) return jsonResponse({ error: queryError.message }, 503, origin);
      const candidates = candidatesRes.data ?? [];
      const history = historyRes.data ?? [];
      const districtGroups = new Map<string, { District: string; 'Total Candidates': number; 'Offers Generated': number; 'Emails Sent': number }>();
      const rows = candidates.map((candidate) => {
        const district = candidate.district || '';
        const summary = districtGroups.get(district) ?? { District: district, 'Total Candidates': 0, 'Offers Generated': 0, 'Emails Sent': 0 };
        summary['Total Candidates'] += 1;
        if (candidate.offer_generated) summary['Offers Generated'] += 1;
        if (history.some((entry) => Number(entry.candidate_id) === Number(candidate.id) && entry.status === 'sent')) summary['Emails Sent'] += 1;
        districtGroups.set(district, summary);
        return {
          ID: candidate.id,
          'Candidate Name': candidate.candidate_name,
          'School Name': candidate.school_name,
          Location: candidate.location,
          District: district,
          'Phone Number': candidate.phone,
          Email: candidate.email,
          'Joining Date': candidate.joining_date,
          'PDF Status': candidate.offer_generated ? 'Generated' : 'Not Generated',
          'PDF Filename': candidate.offer_filename,
          'Verification Status': candidate.verification_status,
        };
      });
      const historyRows = history.map((entry) => ({
        'Batch ID': entry.batch_code,
        'Candidate Name': entry.candidate_name,
        Email: entry.candidate_email,
        CC: entry.cc_emails,
        'PDF Filename': entry.pdf_filename,
        Status: entry.status,
        'Delivery State': entry.delivery_status,
        Provider: entry.provider,
        'Sent At': entry.sent_at,
        'Error Details': entry.error_message,
      }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Notice: 'No candidate records' }]), 'Candidates');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([...districtGroups.values()]), 'District Summary');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(historyRows.length ? historyRows : [{ Notice: 'No sending records' }]), 'Sending History');
      return xlsxResponse(workbook, 'Kalvi40_Analytics_Report.xlsx', origin);
    }

    if (url.pathname === '/api/logs' && request.method === 'GET') {
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const action = url.searchParams.get('action') || '';
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('pageSize') || 25)));
      const { data, error } = await supabase.from('activity_logs').select('*').order('id', { ascending: false });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      const allRows = data ?? [];
      let rows = allRows;
      if (search) rows = rows.filter((row) => [row.admin_email, row.action, row.details].some((value) => String(value || '').toLowerCase().includes(search)));
      if (action && action !== 'all') rows = rows.filter((row) => row.action === action);
      const actions = [...new Set(allRows.map((row) => row.action))].sort();
      return jsonResponse({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, actions }, 200, origin);
    }

    if (url.pathname === '/api/history' && request.method === 'GET') {
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const status = url.searchParams.get('status') || '';
      const batch = url.searchParams.get('batch') || '';
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const pageSize = Math.min(200, Math.max(5, Number(url.searchParams.get('pageSize') || 20)));
      const { data, error } = await supabase.from('send_history').select('*').order('id', { ascending: false });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      const allRows = data ?? [];
      let rows = allRows;
      if (search) rows = rows.filter((row) => [row.candidate_name, row.candidate_email, row.batch_code, row.pdf_filename].some((value) => String(value || '').toLowerCase().includes(search)));
      if (status && status !== 'all') rows = rows.filter((row) => row.status === status);
      if (batch && batch !== 'all') rows = rows.filter((row) => row.batch_code === batch);
      const batches = [...new Set(allRows.map((row) => row.batch_code))].slice(0, 50);
      return jsonResponse({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, batches }, 200, origin);
    }

    const historyRetryMatch = url.pathname.match(/^\/api\/history\/(\d+)\/retry$/);
    if (historyRetryMatch && request.method === 'POST') {
      const historyId = Number(historyRetryMatch[1]);
      const { data: row, error } = await supabase.from('send_history').select('*').eq('id', historyId).maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      if (!row) return jsonResponse({ error: 'History record not found.' }, 404, origin);
      if (row.status === 'sent') return jsonResponse({ error: 'This email was already sent.' }, 400, origin);
      return jsonResponse({ error: 'Configure and verify the Worker HTTP email provider and queue before retrying.' }, 400, origin);
    }

    if (url.pathname === '/api/history/retry-batch' && request.method === 'POST') {
      return jsonResponse({ error: 'Configure and verify the Worker HTTP email provider and queue before retrying.' }, 400, origin);
    }

    if (url.pathname === '/api/history/sync-delivery' && request.method === 'POST') {
      return jsonResponse({ checkedCount: 0, updatedCount: 0, message: 'SMTP relay records acceptance status directly upon dispatch.' }, 200, origin);
    }

    if (url.pathname === '/api/history/export' && request.method === 'GET') {
      const status = url.searchParams.get('status') || '';
      let query = supabase.from('send_history').select('*').order('id', { ascending: false });
      if (status && status !== 'all') query = query.eq('status', status);
      const { data, error } = await query;
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      const rows = (data ?? []).map((entry) => ({
        'Batch ID': entry.batch_code,
        'Candidate Name': entry.candidate_name,
        'Email Address': entry.candidate_email,
        'CC Recipients': entry.cc_emails,
        'PDF Filename': entry.pdf_filename,
        'Queue Status': entry.status,
        'Provider Delivery State': entry.delivery_status,
        Provider: entry.provider,
        'Message ID': entry.provider_message_id,
        Attempts: entry.attempts,
        'Sending Date': entry.sent_at,
        'Error Message': entry.error_message,
      }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Notice: 'No sending history available' }]), 'Sending History');
      return xlsxResponse(workbook, 'Kalvi40-Sending-History.xlsx', origin);
    }

    if (url.pathname === '/api/campaigns' && request.method === 'GET') {
      const { data, error } = await supabase.from('campaigns').select('*').order('id', { ascending: false });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      return jsonResponse({ items: (data ?? []).map(normalizeCampaign) }, 200, origin);
    }

    const campaignMatch = url.pathname.match(/^\/api\/campaigns\/(\d+)$/);
    if (campaignMatch && request.method === 'GET') {
      const campaignId = Number(campaignMatch[1]);
      const [campaignRes, deliveriesRes] = await Promise.all([
        supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle(),
        supabase.from('send_history').select('*').eq('campaign_id', campaignId).order('id', { ascending: true }),
      ]);
      if (campaignRes.error || deliveriesRes.error) return jsonResponse({ error: campaignRes.error?.message || deliveriesRes.error?.message }, 503, origin);
      if (!campaignRes.data) return jsonResponse({ error: 'Campaign not found.' }, 404, origin);
      return jsonResponse({ campaign: normalizeCampaign(campaignRes.data), deliveries: deliveriesRes.data ?? [] }, 200, origin);
    }

    if (url.pathname === '/api/campaigns' && request.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const name = String(body.name || '').trim() || `Kalvi40 Offer Batch ${new Date().toLocaleDateString('en-IN')}`;
      const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.map(Number) : [];
      const ccEmails = Array.isArray(body.ccEmails) ? body.ccEmails.map((email) => String(email).trim()).filter(Boolean) : [];
      const skipAlreadySent = body.skipAlreadySent !== false;
      if (!candidateIds.length) return jsonResponse({ error: 'Select at least one candidate to create a campaign.' }, 400, origin);
      if (!env.EMAIL_QUEUE) return jsonResponse({ error: 'Cloudflare Queue binding EMAIL_QUEUE is not configured.' }, 500, origin);
      const settings = await loadSettings(supabase);
      if (!await getSmtpConfig(settings, env).catch(() => null)) {
        return jsonResponse({ error: 'SMTP credentials are not configured. Configure SMTP settings before launching a bulk campaign.' }, 400, origin);
      }
      const { data: master, error: masterError } = await supabase.from('email_templates')
        .select('*').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
      if (masterError) return jsonResponse({ error: masterError.message }, 503, origin);
      if (!master) return jsonResponse({ error: 'Master email template is missing from Supabase.' }, 503, origin);
      const subject = String(body.subject || master.subject).trim();
      const emailBody = String(body.body || master.body).trim();
      const { data: candidates, error: candidatesError } = await supabase.from('candidates').select('*').order('id', { ascending: true });
      if (candidatesError) return jsonResponse({ error: candidatesError.message }, 503, origin);
      const selectedCandidates = (candidates ?? []).filter((candidate) => candidateIds.includes(Number(candidate.id)));
      if (!selectedCandidates.length) return jsonResponse({ error: 'No matching candidates found.' }, 404, origin);
      const valid: Array<{ candidate: Record<string, unknown>; subject: string; body: string; filename: string }> = [];
      const blocked: Array<{ id: number; name: string; email: string; reason: string }> = [];
      for (const candidate of selectedCandidates) {
        if (skipAlreadySent) {
          const { data: already, error } = await supabase.from('send_history').select('batch_code')
            .eq('candidate_id', candidate.id).in('status', ['sent', 'pending', 'processing']).limit(1).maybeSingle();
          if (error) return jsonResponse({ error: error.message }, 503, origin);
          if (already) {
            blocked.push({ id: Number(candidate.id), name: String(candidate.candidate_name), email: String(candidate.email), reason: `Already sent or queued in ${already.batch_code} (duplicate prevented).` });
            continue;
          }
        }
        let verification;
        try {
          verification = await verifyCandidateForSending(supabase, env, candidate, { subject, body: emailBody }, true);
        } catch (error) {
          blocked.push({ id: Number(candidate.id), name: String(candidate.candidate_name), email: String(candidate.email), reason: error instanceof Error ? error.message : 'Verification failed.' });
          continue;
        }
        if (!verification.valid) blocked.push({ id: Number(candidate.id), name: String(candidate.candidate_name), email: String(candidate.email), reason: verification.issues.join(' | ') });
        else valid.push({ candidate, subject: verification.renderedSubject, body: verification.renderedBody, filename: verification.pdfFilename });
      }
      if (!valid.length) return jsonResponse({ error: blocked[0]?.reason || 'No valid eligible candidates to send in this batch.', blockedCandidates: blocked }, 422, origin);

      const batchCode = `BATCH-${now().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-6)}`;
      const jobs = valid.map((entry) => ({
        candidate_id: entry.candidate.id,
        candidate_name: entry.candidate.candidate_name,
        candidate_email: entry.candidate.email,
        cc_emails: ccEmails.join(', '),
        pdf_filename: entry.filename,
        subject: entry.subject,
        body_rendered: entry.body,
      }));
      const { data: createdId, error: createError } = await supabase.rpc('kalvi40_create_campaign', {
        p_batch_code: batchCode,
        p_name: name,
        p_subject: subject,
        p_body: emailBody,
        p_cc_emails: ccEmails,
        p_total_count: selectedCandidates.length,
        p_valid_count: valid.length,
        p_created_by: String(session.email || ''),
        p_jobs: jobs,
      });
      if (createError) return jsonResponse({ error: `Unable to create campaign transactionally in Supabase: ${createError.message}` }, 503, origin);
      const campaignId = Number(typeof createdId === 'number' ? createdId : createdId && typeof createdId === 'object' ? Object.values(createdId as Record<string, unknown>)[0] : createdId);
      const { data: campaign, error: campaignError } = await supabase.from('campaigns').select('*').eq('id', campaignId).single();
      if (campaignError) return jsonResponse({ error: `Campaign was created but could not be reloaded: ${campaignError.message}` }, 503, origin);
      const { data: queuedRows, error: queueReadError } = await supabase.from('send_history').select('*').eq('campaign_id', campaignId).order('id', { ascending: true });
      if (queueReadError) return jsonResponse({ error: `Campaign was created but its queue rows could not be loaded: ${queueReadError.message}` }, 503, origin);
      let queuedCount = 0;
      for (const item of queuedRows ?? []) {
        const job: BulkEmailJob = {
          historyId: Number(item.id),
          campaignId,
          candidateId: Number(item.candidate_id),
          toEmail: String(item.candidate_email),
          toName: String(item.candidate_name),
          ccEmails: String(item.cc_emails || '').split(',').map((email) => email.trim()).filter(Boolean),
          subject: String(item.subject),
          bodyText: String(item.body_rendered || ''),
          pdfFilename: String(item.pdf_filename),
        };
        try {
          await env.EMAIL_QUEUE.send(job);
          queuedCount += 1;
        } catch (error) {
          await supabase.from('send_history').update({ status: 'failed', delivery_status: 'failed', error_message: error instanceof Error ? error.message : 'Unable to enqueue email.', updated_at: now() }).eq('id', item.id);
        }
      }
      await updateCampaignCounters(supabase, campaignId);
      try {
        await recordAdminActivity(supabase, request, session, 'CAMPAIGN_LAUNCHED', 'campaign',
          `Queued bulk campaign ${batchCode} ("${name}") with ${queuedCount} emails (${blocked.length} excluded/blocked).`, campaignId);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      const { data: refreshedCampaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      return jsonResponse({ campaign: normalizeCampaign(refreshedCampaign ?? campaign), queuedCount, blockedCount: blocked.length, blockedCandidates: blocked }, 202, origin);
    }

    if (url.pathname === '/api/cc' && request.method === 'GET') {
      const { data, error } = await supabase.from('cc_recipients').select('*').order('id', { ascending: true });
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      return jsonResponse({ items: (data ?? []).map((item) => ({ ...item, enabled: item.enabled ? 1 : 0, is_default: item.is_default ? 1 : 0 })) }, 200, origin);
    }

    if (url.pathname === '/api/cc' && request.method === 'POST') {
      let body: { email?: unknown; label?: unknown; is_default?: unknown };
      try {
        body = await request.json() as { email?: unknown; label?: unknown; is_default?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const email = String(body.email || '').trim().toLowerCase();
      const label = String(body.label || '').trim();
      const isDefault = body.is_default !== false;
      if (!validEmail(email)) return jsonResponse({ error: 'Please provide a valid CC email address.' }, 400, origin);
      const { data: existing, error: lookupError } = await supabase.from('cc_recipients').select('id').eq('email', email).maybeSingle();
      if (lookupError) return jsonResponse({ error: lookupError.message }, 503, origin);
      if (existing) return jsonResponse({ error: `"${email}" is already in the CC list.` }, 409, origin);
      const { data, error } = await supabase.from('cc_recipients').insert({ email, label, enabled: true, is_default: isDefault }).select('*').single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'CC_ADDED', 'cc_recipient', `Added CC recipient ${email} (${label || 'No label'})`, Number(data.id));
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ item: { ...data, enabled: data.enabled ? 1 : 0, is_default: data.is_default ? 1 : 0 } }, 201, origin);
    }

    const ccMatch = url.pathname.match(/^\/api\/cc\/(\d+)$/);
    if (ccMatch && request.method === 'PUT') {
      const id = Number(ccMatch[1]);
      const { data: existing, error: lookupError } = await supabase.from('cc_recipients').select('*').eq('id', id).maybeSingle();
      if (lookupError) return jsonResponse({ error: lookupError.message }, 503, origin);
      if (!existing) return jsonResponse({ error: 'CC recipient not found.' }, 404, origin);
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : existing.email;
      if (!validEmail(email)) return jsonResponse({ error: 'Invalid CC email address.' }, 400, origin);
      const patch = {
        email,
        label: body.label !== undefined ? String(body.label).trim() : existing.label,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
        is_default: body.is_default !== undefined ? Boolean(body.is_default) : existing.is_default,
      };
      const { data, error } = await supabase.from('cc_recipients').update(patch).eq('id', id).select('*').single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'CC_UPDATED', 'cc_recipient', `Updated CC recipient ${data.email} (enabled: ${Boolean(data.enabled)})`, id);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ item: { ...data, enabled: data.enabled ? 1 : 0, is_default: data.is_default ? 1 : 0 } }, 200, origin);
    }

    if (ccMatch && request.method === 'DELETE') {
      const id = Number(ccMatch[1]);
      const { data: existing, error: lookupError } = await supabase.from('cc_recipients').select('email').eq('id', id).maybeSingle();
      if (lookupError) return jsonResponse({ error: lookupError.message }, 503, origin);
      if (!existing) return jsonResponse({ error: 'CC recipient not found.' }, 404, origin);
      const { error } = await supabase.from('cc_recipients').delete().eq('id', id);
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'CC_DELETED', 'cc_recipient', `Removed CC recipient ${existing.email}`, id);
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ message: 'CC recipient removed.' }, 200, origin);
    }

    if (url.pathname === '/api/send/individual' && request.method === 'POST') {
      let body: { candidateId?: unknown; ccEmails?: unknown; allowResend?: unknown };
      try {
        body = await request.json() as { candidateId?: unknown; ccEmails?: unknown; allowResend?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const candidateId = Number(body.candidateId);
      const candidate = await getCandidate(supabase, candidateId);
      if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      const settings = await loadSettings(supabase);
      const smtpConfig = await getSmtpConfig(settings, env).catch(() => null);
      if (!smtpConfig) return jsonResponse({ error: 'SMTP credentials are not configured. Configure your SMTP settings before sending.' }, 400, origin);
      const allowResend = Boolean(body.allowResend);
      if (!allowResend) {
        const { data: alreadySent, error } = await supabase.from('send_history')
          .select('id,batch_code,sent_at').eq('candidate_id', candidateId).eq('status', 'sent').limit(1).maybeSingle();
        if (error) return jsonResponse({ error: error.message }, 503, origin);
        if (alreadySent) return jsonResponse({ error: `An offer email was already sent to ${candidate.email} in ${alreadySent.batch_code}. Confirm "Allow Resend" if you intend to send a duplicate.` }, 409, origin);
      }
      let verification;
      try {
        verification = await verifyCandidateForSending(supabase, env, candidate, undefined, true);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Candidate verification failed.' }, 503, origin);
      }
      if (!verification.valid) return jsonResponse({ error: `Verification failed: ${verification.issues.join(' | ')}`, verification }, 422, origin);
      let ccEmails: string[];
      if (Array.isArray(body.ccEmails)) {
        ccEmails = body.ccEmails.map(String);
      } else {
        const { data, error } = await supabase.from('cc_recipients').select('*').order('id', { ascending: true });
        if (error) return jsonResponse({ error: error.message }, 503, origin);
        ccEmails = (data ?? []).filter((item) => item.enabled && item.is_default).map((item) => String(item.email));
      }
      let attachmentBytes = await loadStoredPdf(supabase, env, verification.pdfFilename);
      if (!attachmentBytes) attachmentBytes = (await generateAndStorePdf(supabase, env, candidate)).bytes;
      const send = await sendWorkerEmail(env, settings, {
        toEmail: String(candidate.email),
        toName: String(candidate.candidate_name),
        ccEmails,
        subject: verification.renderedSubject,
        bodyText: verification.renderedBody,
        attachmentFilename: verification.pdfFilename,
        attachmentBytes,
      });
      const batchCode = `IND-${now().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
      const { data: history, error: historyError } = await supabase.from('send_history').insert({
        campaign_id: null,
        batch_code: batchCode,
        candidate_id: candidateId,
        candidate_name: candidate.candidate_name,
        candidate_email: candidate.email,
        cc_emails: ccEmails.join(', '),
        pdf_filename: verification.pdfFilename,
        subject: verification.renderedSubject,
        body_rendered: verification.renderedBody,
        status: send.success ? 'sent' : 'failed',
        provider: send.provider,
        provider_message_id: send.messageId,
        delivery_status: send.deliveryStatus,
        error_message: send.errorMessage,
        attempts: 1,
        sent_at: send.success ? now() : null,
      }).select('id').single();
      if (historyError) return jsonResponse({ error: `Email was dispatched, but history could not be saved to Supabase: ${historyError.message}` }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, send.success ? 'INDIVIDUAL_EMAIL_SENT' : 'INDIVIDUAL_EMAIL_FAILED', 'send_history',
          send.success ? `Sent individual offer (${verification.pdfFilename}) to ${candidate.email} via ${send.provider}` : `Failed individual offer to ${candidate.email}: ${send.errorMessage}`, Number(history.id));
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      if (!send.success) return jsonResponse({ error: send.errorMessage || 'Email delivery failed.', historyId: history.id }, 502, origin);
      return jsonResponse({ message: `Offer email accepted by ${send.provider} for ${candidate.email}.`, batchCode, messageId: send.messageId, historyId: history.id }, 200, origin);
    }

    if (url.pathname === '/api/templates/master' && request.method === 'GET') {
      const { data, error } = await supabase.from('email_templates').select('*').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      if (!data) return jsonResponse({ error: 'Master email template is missing from Supabase.' }, 503, origin);
      return jsonResponse({ template: { ...data, is_master: data.is_master ? 1 : 0 } }, 200, origin);
    }

    if (url.pathname === '/api/templates/master' && request.method === 'PUT') {
      let body: { subject?: unknown; body?: unknown };
      try {
        body = await request.json() as { subject?: unknown; body?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const subject = String(body.subject || '').trim();
      const text = String(body.body || '').trim();
      if (!subject || !text) return jsonResponse({ error: 'Email subject and body cannot be empty.' }, 400, origin);
      const { data: current, error: currentError } = await supabase.from('email_templates')
        .select('id').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
      if (currentError) return jsonResponse({ error: currentError.message }, 503, origin);
      if (!current) return jsonResponse({ error: 'Master email template is missing from Supabase.' }, 503, origin);
      const { data, error } = await supabase.from('email_templates')
        .update({ subject, body: text, updated_by: String(session.email || ''), updated_at: now() })
        .eq('id', current.id).select('*').single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'TEMPLATE_UPDATED', 'email_template', `Updated master email template subject: "${subject}"`, Number(current.id));
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ template: { ...data, is_master: data.is_master ? 1 : 0 } }, 200, origin);
    }

    if (url.pathname === '/api/templates/master/reset' && request.method === 'POST') {
      const { data: current, error: currentError } = await supabase.from('email_templates')
        .select('id').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
      if (currentError) return jsonResponse({ error: currentError.message }, 503, origin);
      if (!current) return jsonResponse({ error: 'Master email template is missing from Supabase.' }, 503, origin);
      const { data, error } = await supabase.from('email_templates')
        .update({ subject: DEFAULT_MASTER_SUBJECT, body: DEFAULT_MASTER_BODY, updated_by: String(session.email || ''), updated_at: now() })
        .eq('id', current.id).select('*').single();
      if (error) return jsonResponse({ error: error.message }, 503, origin);
      try {
        await recordAdminActivity(supabase, request, session, 'TEMPLATE_RESET', 'email_template', 'Reset master email template to Kalvi40 default content.', Number(current.id));
      } catch (activityError) {
        return jsonResponse({ error: activityError instanceof Error ? activityError.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse({ template: { ...data, is_master: data.is_master ? 1 : 0 } }, 200, origin);
    }

    if (url.pathname === '/api/templates/offer' && request.method === 'GET') {
      try {
        const settings = await loadSettings(supabase);
        return jsonResponse({ template: offerTemplateFromSettings(settings) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load offer settings.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/general' && request.method === 'GET') {
      let settings: Map<string, string>;
      try {
        settings = await loadSettings(supabase);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load settings.' }, 503, origin);
      }
      const get = (key: string, fallback: string) => settings.get(key) || fallback;
      return jsonResponse({ settings: {
        organization_name: get('organization_name', 'BumbleB Trust'),
        program_name: get('program_name', 'Kalvi40'),
        contract_end_date: get('contract_end_date', '30.04.2027'),
        stipend_text: get('stipend_text', 'INR. 3000/- per month with effect from Oct 2026 as stipend.'),
        trust_address: get('trust_address', 'No.63, 2nd Main Road, Sankarapuram, Sithalapakkam, Chennai - 600126.'),
        trust_regn: get('trust_regn', '(A Public Charitable Trust / Regn. No.125 /2019 BKIV)'),
        trust_mobile: get('trust_mobile', '+91 97910 07318'),
        trust_email: get('trust_email', 'prem@bumbleb.org.in'),
        trust_website: get('trust_website', 'www.bumbleb.org.in'),
        supabase_configured: true,
        supabase_url: env.SUPABASE_URL || '',
      } }, 200, origin);
    }

    if (url.pathname === '/api/settings/general' && request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const allowed = ['organization_name', 'program_name', 'contract_end_date', 'stipend_text', 'trust_address', 'trust_regn', 'trust_mobile', 'trust_email', 'trust_website'];
      const values: Record<string, string> = {};
      for (const key of allowed) if (body[key] !== undefined) values[key] = String(body[key]).trim();
      try {
        await saveSettings(supabase, values);
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'GENERAL_SETTINGS_UPDATED', 'settings', 'Updated general organization and offer letter letterhead configuration.');
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to save general settings.' }, 503, origin);
      }
      return jsonResponse({ message: 'General settings saved.' }, 200, origin);
    }

    if (url.pathname === '/api/templates/offer' && request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const heading = String(body.heading ?? '').trim();
      const text = String(body.body ?? '').trim();
      if (!heading || !text) return jsonResponse({ error: 'Offer letter heading and body content cannot be empty.' }, 400, origin);
      const values: Record<string, string> = { offer_heading: heading, offer_body: text };
      const settingsMap: Record<string, string> = {
        header_name: 'offer_header_name', header_role: 'offer_header_role', brand_title: 'offer_brand_title',
        brand_subtitle: 'offer_brand_subtitle', trust_regn: 'trust_regn', trust_address: 'trust_address',
        trust_mobile: 'trust_mobile', trust_email: 'trust_email', trust_website: 'trust_website',
        greeting: 'offer_greeting', closing: 'offer_closing', signatory_title: 'offer_signatory_title',
        signatory_org: 'offer_signatory_org', contract_end_date: 'contract_end_date', stipend_text: 'stipend_text',
        footer_left_url: 'offer_footer_left_url', footer_right_url: 'offer_footer_right_url',
      };
      for (const [field, key] of Object.entries(settingsMap)) {
        if (typeof body[field] === 'string' && String(body[field]).trim()) values[key] = String(body[field]).trim();
      }
      if (body.body_font_size !== undefined) {
        const fontSize = Number(body.body_font_size);
        if (Number.isFinite(fontSize)) values.offer_body_font_size = String(Math.max(9, Math.min(12.5, Number(fontSize.toFixed(1)))));
      }
      try {
        await saveSettings(supabase, values);
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'OFFER_TEMPLATE_UPDATED', 'offer_template', `Updated master offer letter PDF template ("${heading}"). Existing PDFs queued for fresh generation.`);
        return jsonResponse({ template: offerTemplateFromSettings(await loadSettings(supabase)) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to save offer template.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/templates/offer/preview-pdf' && request.method === 'POST') {
      let body: { template?: unknown; candidateId?: unknown };
      try {
        body = await request.json() as { template?: unknown; candidateId?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const requestedId = Number(body.candidateId || 0);
      let candidate: Record<string, unknown> | null = null;
      if (requestedId) {
        candidate = await getCandidate(supabase, requestedId);
        if (!candidate) return jsonResponse({ error: 'Candidate not found.' }, 404, origin);
      } else {
        const { data, error } = await supabase.from('candidates').select('*').order('id', { ascending: true }).limit(1).maybeSingle();
        if (error) return jsonResponse({ error: error.message }, 503, origin);
        candidate = data ?? null;
      }
      candidate ??= {
        candidate_name: 'E Sathiya Kaviya',
        school_name: 'Govt Panchayat Union Middle School',
        location: 'Pattiyandal',
        district: 'Tiruvannamalai',
        email: 'candidate@example.com',
        joining_date: '21.10.2026',
        custom_offer_body: null,
      };
      try {
        const baseTemplate = offerTemplateFromSettings(await loadSettings(supabase));
        const draft = body.template && typeof body.template === 'object' ? body.template as Record<string, unknown> : {};
        const template = { ...baseTemplate, ...draft } as typeof DEFAULT_OFFER_LETTER_TEMPLATE;
        const { bytes, filename } = await buildOfferLetterPdfBuffer({ ...candidate, custom_offer_body: null }, template);
        return pdfResponse(bytes, filename, 'inline', origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to create offer preview.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/templates/offer/reset' && request.method === 'POST') {
      const template = DEFAULT_OFFER_LETTER_TEMPLATE;
      const values: Record<string, string> = {
        offer_header_name: template.header_name, offer_header_role: template.header_role,
        offer_brand_title: template.brand_title, offer_brand_subtitle: template.brand_subtitle,
        trust_regn: template.trust_regn, trust_address: template.trust_address, trust_mobile: template.trust_mobile,
        trust_email: template.trust_email, trust_website: template.trust_website, offer_heading: template.heading,
        offer_greeting: template.greeting, offer_body: template.body, offer_closing: template.closing,
        offer_signatory_title: template.signatory_title, offer_signatory_org: template.signatory_org,
        contract_end_date: template.contract_end_date, stipend_text: template.stipend_text,
        offer_footer_left_url: template.footer_left_url, offer_footer_right_url: template.footer_right_url,
        offer_body_font_size: String(template.body_font_size),
      };
      try {
        await saveSettings(supabase, values);
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'OFFER_TEMPLATE_RESET', 'offer_template', 'Reset master offer letter PDF template to original BumbleB Trust default.');
        return jsonResponse({ template: offerTemplateFromSettings(await loadSettings(supabase)) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to reset offer template.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/email' && request.method === 'GET') {
      try {
        const settings = await loadSettings(supabase);
        return jsonResponse({ config: publicEmailConfig(settings, env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load email settings.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/email' && request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      let currentSettings: Map<string, string>;
      try {
        currentSettings = await loadSettings(supabase);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load email settings.' }, 503, origin);
      }
      const host = typeof body.smtp_host === 'string' ? body.smtp_host.trim() : currentSettings.get('smtp_host') || 'smtp.gmail.com';
      if (typeof body.smtp_host === 'string' && (!host || host.includes('@') || /\s/.test(host))) {
        return jsonResponse({ error: `Invalid SMTP Host "${host}". Enter a mail server hostname such as smtp.gmail.com, not an email address.` }, 400, origin);
      }
      const submittedPassword = typeof body.smtp_pass === 'string' ? body.smtp_pass.trim() : '';
      const values: Record<string, string> = { email_provider: 'smtp' };
      for (const key of ['sender_name', 'sender_email', 'reply_to', 'smtp_user']) {
        if (typeof body[key] === 'string') values[key] = String(body[key]).trim();
      }
      if (typeof body.smtp_host === 'string') values.smtp_host = host;
      if (body.smtp_port !== undefined) values.smtp_port = String(Math.max(1, Math.min(65535, Number(body.smtp_port) || 587)));
      if (body.smtp_secure !== undefined) values.smtp_secure = body.smtp_secure ? 'true' : 'false';
      if (body.rate_limit_per_minute !== undefined) values.rate_limit_per_minute = String(Math.max(1, Math.min(300, Number(body.rate_limit_per_minute) || 45)));
      if (body.max_retries !== undefined) values.max_retries = String(Math.max(0, Math.min(5, Number(body.max_retries) || 3)));
      try {
        if (submittedPassword && !submittedPassword.includes('••••')) {
          const jwtSecret = env.JWT_SECRET?.trim();
          if (!jwtSecret) return jsonResponse({ error: 'JWT_SECRET is required to encrypt the email credential.' }, 503, origin);
          const encrypted = await encryptEmailCredential(submittedPassword, jwtSecret);
          const { error } = await supabase.from('system_settings').upsert({ key: 'smtp_pass_encrypted', value: encrypted, updated_at: now() }, { onConflict: 'key' });
          if (error) return jsonResponse({ error: `Unable to store encrypted email credential: ${error.message}` }, 503, origin);
        }
        await saveSettings(supabase, values);
        await recordAdminActivity(supabase, request, session, 'EMAIL_CONFIG_UPDATED', 'settings', `Updated SMTP configuration (${host}:${values.smtp_port || currentSettings.get('smtp_port') || '587'}, sender: ${values.sender_email || currentSettings.get('sender_email') || ''}).`);
        return jsonResponse({ config: publicEmailConfig(await loadSettings(supabase), env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to save email settings.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/email/test-connection' && request.method === 'POST') {
      let result: { ok: boolean; provider: string; accountInfo?: string; error?: string };
      try {
        const settings = await loadSettings(supabase);
        const config = await getSmtpConfig(settings, env);
        result = config
          ? await verifySmtpConnection(config, await getSmtpConnector())
          : { ok: false, provider: 'smtp', error: 'SMTP host, username, and password are required before testing the connection.' };
      } catch (error) {
        result = { ok: false, provider: 'smtp', error: error instanceof Error ? error.message : 'SMTP handshake failed.' };
      }
      try {
        await recordAdminActivity(supabase, request, session, 'EMAIL_CONNECTION_TEST', 'settings', result.ok
          ? `Verified ${result.provider} connection: ${result.accountInfo}`
          : `Connection test failed (${result.provider}): ${result.error}`);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to write activity log.' }, 503, origin);
      }
      return jsonResponse(result, result.ok ? 200 : 400, origin);
    }

    if (url.pathname === '/api/settings/email/send-test' && request.method === 'POST') {
      let body: { toEmail?: unknown };
      try {
        body = await request.json() as { toEmail?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const email = String(body.toEmail || '').trim().toLowerCase();
      if (!validEmail(email)) return jsonResponse({ error: 'Provide a valid recipient email address for the test email.' }, 400, origin);
      try {
        const settings = await loadSettings(supabase);
        const { data: candidate, error: candidateError } = await supabase.from('candidates').select('*').order('id', { ascending: true }).limit(1).maybeSingle();
        if (candidateError) return jsonResponse({ error: candidateError.message }, 503, origin);
        const { data: template, error: templateError } = await supabase.from('email_templates')
          .select('*').eq('is_master', true).order('id', { ascending: false }).limit(1).maybeSingle();
        if (templateError) return jsonResponse({ error: templateError.message }, 503, origin);
        if (!template) return jsonResponse({ error: 'Master email template is missing from Supabase.' }, 503, origin);
        let bodyText = 'Kalvi40 email provider verification test message.';
        let attachmentBytes = new TextEncoder().encode('Test attachment');
        let attachmentFilename = 'Kalvi40_Test_Offer.pdf';
        if (candidate) {
          bodyText = renderTemplateString(String(template.body), candidate as never, {
            contract_end_date: offerTemplateFromSettings(settings).contract_end_date,
            stipend_text: offerTemplateFromSettings(settings).stipend_text,
          });
          const generated = await generateAndStorePdf(supabase, env, candidate);
          attachmentBytes = new Uint8Array(generated.bytes);
          attachmentFilename = generated.filename;
        }
        const result = await sendWorkerEmail(env, settings, {
          toEmail: email,
          toName: 'Kalvi40 Administrator Test',
          ccEmails: [],
          subject: `[Test] ${template.subject}`,
          bodyText,
          attachmentFilename,
          attachmentBytes,
        });
        if (!result.success) return jsonResponse({ error: result.errorMessage || 'Test email delivery failed.' }, 400, origin);
        return jsonResponse({ message: `Test email with PDF attachment accepted by ${result.provider} (Message ID: ${result.messageId || 'N/A'}).`, messageId: result.messageId }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to send test email.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/signature' && request.method === 'GET') {
      try {
        return jsonResponse({ signature: await getFounderSignatureInfo(supabase, env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to load signature.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/signature' && request.method === 'POST') {
      let body: { imageDataUrl?: unknown; heightPt?: unknown };
      try {
        body = await request.json() as { imageDataUrl?: unknown; heightPt?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const raw = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
      const match = raw.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) return jsonResponse({ error: 'Invalid signature image format. Please upload a valid PNG or JPG image.' }, 400, origin);
      let bytes: Uint8Array;
      try {
        const binary = atob(match[2].replace(/\s+/g, ''));
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } catch {
        return jsonResponse({ error: 'Invalid signature image encoding.' }, 400, origin);
      }
      if (bytes.length < 32 || bytes.length > 5 * 1024 * 1024) return jsonResponse({ error: 'Signature image must be valid and 5 MB or smaller.' }, 400, origin);
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isPng && !isJpeg) return jsonResponse({ error: 'Uploaded file is not a valid PNG or JPEG image.' }, 400, origin);
      const filename = `founder_signature.${isPng ? 'png' : 'jpg'}`;
      const mime = isPng ? 'image/png' : 'image/jpeg';
      const { error: storageError } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters')
        .upload(filename, bytes, { contentType: mime, upsert: true });
      if (storageError) return jsonResponse({ error: `Unable to store signature in Supabase Storage: ${storageError.message}` }, 503, origin);
      const values: Record<string, string> = {
        founder_signature_filename: filename,
        founder_signature_mime: mime,
        founder_signature_updated_at: now(),
      };
      if (body.heightPt !== undefined) values.founder_signature_height = String(Math.max(24, Math.min(72, Math.round(Number(body.heightPt) || 40))));
      try {
        await saveSettings(supabase, values);
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'FOUNDER_SIGNATURE_UPLOADED', 'settings', `Uploaded custom Founder signature (${filename}, ${(bytes.length / 1024).toFixed(1)} KB).`);
        return jsonResponse({ message: 'Founder signature uploaded successfully.', signature: await getFounderSignatureInfo(supabase, env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to save signature settings.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/signature/options' && request.method === 'PUT') {
      let body: { heightPt?: unknown };
      try {
        body = await request.json() as { heightPt?: unknown };
      } catch {
        return jsonResponse({ error: 'Request body must be valid JSON.' }, 400, origin);
      }
      const height = Math.max(24, Math.min(72, Math.round(Number(body.heightPt) || 40)));
      try {
        await saveSettings(supabase, { founder_signature_height: String(height), founder_signature_updated_at: now() });
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'FOUNDER_SIGNATURE_RESIZED', 'settings', `Updated Founder signature height to ${height} pt.`);
        return jsonResponse({ message: 'Founder signature size updated.', signature: await getFounderSignatureInfo(supabase, env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to update signature size.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/settings/signature' && request.method === 'DELETE') {
      try {
        await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET || 'offer-letters')
          .remove(['founder_signature.png', 'founder_signature.jpg']);
        await saveSettings(supabase, { founder_signature_filename: '', founder_signature_mime: '', founder_signature_updated_at: '' });
        await invalidateCandidatePdfs(supabase);
        await recordAdminActivity(supabase, request, session, 'FOUNDER_SIGNATURE_REMOVED', 'settings', 'Removed uploaded Founder signature and restored default signature.');
        return jsonResponse({ message: 'Founder signature reset to default.', signature: await getFounderSignatureInfo(supabase, env) }, 200, origin);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to reset signature.' }, 503, origin);
      }
    }

    if (url.pathname === '/api/import/sample-excel' && request.method === 'GET') {
      const rows = [
        { 'Candidate Name': 'Sample Candidate One', 'School Name': 'Sample Government Middle School', Location: 'Sample Town', District: 'Tiruvannamalai', 'Mobile Number': '9000000001', Email: 'candidate1@example.org', 'Joining Date': '21.10.2026' },
        { 'Candidate Name': 'Sample Candidate Two', 'School Name': 'Sample Girls Higher Secondary School', Location: 'Sample City', District: 'Chengalpattu', 'Mobile Number': '9000000002', Email: 'candidate2@example.org', 'Joining Date': '01.11.2026' },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Candidates');
      return xlsxResponse(workbook, 'Kalvi40_Candidate_Import_Template.xlsx', origin);
    }

    if (url.pathname === '/api/campaigns' && request.method === 'POST') {
      const body = (await request.json()) as { jobs?: BulkEmailJob[] };
      const jobs = body.jobs || [];
      if (!env.EMAIL_QUEUE) {
        return jsonResponse({ error: 'Cloudflare Queue binding EMAIL_QUEUE is not configured.' }, 500, origin);
      }
      for (const job of jobs) {
        await env.EMAIL_QUEUE.send(job);
      }
      return jsonResponse({ queuedCount: jobs.length }, 202, origin);
    }

    return jsonResponse({ error: 'Route not mapped in worker stub; deploy Express/Node API or map route.' }, 404, origin);
  },

  async queue(batch: { messages: WorkerQueueMessage[] }, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueMessage(message, env);
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};
