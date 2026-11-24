import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseServerClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;

  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

type CandidateSyncInput = {
  id: number;
  candidate_name: string;
  school_name: string;
  location: string;
  district: string;
  phone: string;
  email: string;
  joining_date: string;
  offer_generated?: number;
  offer_generated_at?: string | null;
  offer_filename?: string | null;
  verification_status?: string;
  verification_issues?: string | null;
  custom_offer_body?: string | null;
};

function toSupabaseCandidatePayload(candidate: CandidateSyncInput) {
  return {
    candidate_name: candidate.candidate_name,
    school_name: candidate.school_name,
    location: candidate.location,
    district: candidate.district,
    phone: candidate.phone,
    email: candidate.email.toLowerCase(),
    joining_date: candidate.joining_date,
    offer_generated: Boolean(candidate.offer_generated),
    offer_generated_at: candidate.offer_generated_at || null,
    offer_filename: candidate.offer_filename || null,
    verification_status: candidate.verification_status || 'unverified',
    verification_issues: candidate.verification_issues ? (() => {
      try { return JSON.parse(candidate.verification_issues); } catch { return null; }
    })() : null,
    custom_offer_body: candidate.custom_offer_body || null,
    updated_at: new Date().toISOString(),
  };
}

export async function syncCandidateToSupabase(candidate: CandidateSyncInput, previousEmail?: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const payload = toSupabaseCandidatePayload(candidate);

  const previous = previousEmail?.trim().toLowerCase();
  let result;
  if (previous && previous !== payload.email) {
    const existing = await supabase.from('candidates').select('id').eq('email', previous).maybeSingle();
    if (existing.error) return { ok: false, error: existing.error.message };
    result = existing.data
      ? await supabase.from('candidates').update(payload).eq('id', existing.data.id)
      : await supabase.from('candidates').upsert(payload, { onConflict: 'email' });
  } else {
    result = await supabase.from('candidates').upsert(payload, { onConflict: 'email' });
  }
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function syncCandidatesToSupabase(candidates: CandidateSyncInput[]): Promise<{ ok: boolean; error?: string }> {
  if (candidates.length === 0) return { ok: true };
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const result = await supabase.from('candidates').upsert(
    candidates.map(toSupabaseCandidatePayload),
    { onConflict: 'email' }
  );
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function deleteCandidatesFromSupabase(emails: string[]): Promise<{ ok: boolean; error?: string }> {
  if (emails.length === 0) return { ok: true };
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const result = await supabase.from('candidates').delete().in('email', emails.map((email) => email.toLowerCase()));
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function syncMasterEmailTemplateToSupabase(template: {
  name: string;
  subject: string;
  body: string;
  updated_by: string | null;
  updated_at?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const values = {
    name: template.name,
    subject: template.subject,
    body: template.body,
    is_master: true,
    updated_by: template.updated_by,
    updated_at: template.updated_at || new Date().toISOString(),
  };
  const current = await supabase.from('email_templates').select('id').eq('is_master', true).limit(1).maybeSingle();
  if (current.error) return { ok: false, error: current.error.message };

  const result = current.data
    ? await supabase.from('email_templates').update(values).eq('id', current.data.id)
    : await supabase.from('email_templates').insert(values);
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function syncCcRecipientToSupabase(recipient: {
  email: string;
  label: string;
  enabled: number | boolean;
  is_default: number | boolean;
  previousEmail?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const result = await supabase.from('cc_recipients').upsert(
    {
      email: recipient.email.toLowerCase(),
      label: recipient.label,
      enabled: Boolean(recipient.enabled),
      is_default: Boolean(recipient.is_default),
    },
    { onConflict: 'email' }
  );
  if (result.error) return { ok: false, error: result.error.message };
  const previousEmail = recipient.previousEmail?.trim().toLowerCase();
  if (previousEmail && previousEmail !== recipient.email.toLowerCase()) {
    const cleanup = await supabase.from('cc_recipients').delete().eq('email', previousEmail);
    if (cleanup.error) return { ok: false, error: cleanup.error.message };
  }
  return { ok: true };
}

export async function deleteCcRecipientFromSupabase(email: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const result = await supabase.from('cc_recipients').delete().eq('email', email.toLowerCase());
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

const NEVER_SYNC_SETTINGS = new Set([
  'smtp_pass',
  'smtp_password',
  'brevo_api_key',
  'api_key',
  'supabase_service_role_key',
  'jwt_secret',
]);

export async function syncSettingsToSupabase(settings: Array<{ key: string; value: string }>): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const safeSettings = settings.filter((setting) => !NEVER_SYNC_SETTINGS.has(setting.key.toLowerCase()));
  if (safeSettings.length === 0) return { ok: true };

  const result = await supabase.from('system_settings').upsert(
    safeSettings.map(({ key, value }) => ({ key, value, updated_at: new Date().toISOString() })),
    { onConflict: 'key' }
  );
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export async function syncAdminToSupabase(admin: {
  currentEmail: string;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  designation: string;
  phone: string;
  last_login_at?: string | null;
  created_at?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Supabase server configuration is missing.' };

  const current = await supabase.from('admins').select('id').eq('email', admin.currentEmail.toLowerCase()).maybeSingle();
  if (current.error) return { ok: false, error: current.error.message };

  const values = {
    name: admin.name,
    email: admin.email.toLowerCase(),
    password_hash: admin.password_hash,
    role: admin.role,
    designation: admin.designation,
    phone: admin.phone,
    last_login_at: admin.last_login_at || null,
    updated_at: new Date().toISOString(),
  };
  const result = current.data
    ? await supabase.from('admins').update(values).eq('id', current.data.id)
    : await supabase.from('admins').upsert(
        { ...values, created_at: admin.created_at || new Date().toISOString() },
        { onConflict: 'email' }
      );
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}
