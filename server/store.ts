import { getSupabaseServerClient } from './supabase.ts';

const settingCache = new Map<string, string>();
const runtimeSecrets = new Map<string, string>();
const secretSetting = /(?:pass(?:word)?|secret|api.?key|token|credential)/i;

export function requireSupabase() {
  const client = getSupabaseServerClient();
  if (!client) {
    throw new Error('Supabase server configuration is missing. Set SUPABASE_URL and server-only SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.');
  }
  return client;
}

export async function initializeSupabaseStore(): Promise<void> {
  await refreshSupabaseSettings();
}

export async function refreshSupabaseSettings(): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client.from('system_settings').select('key,value');
  if (error) throw new Error(`Unable to load Supabase system_settings: ${error.message}`);
  settingCache.clear();
  for (const row of data ?? []) {
    if (!secretSetting.test(String(row.key))) settingCache.set(String(row.key), String(row.value ?? ''));
  }
}

export function cacheSupabaseSettings(rows: Array<{ key: string; value: string }>): void {
  settingCache.clear();
  for (const row of rows) {
    if (!secretSetting.test(String(row.key))) settingCache.set(String(row.key), String(row.value ?? ''));
  }
}

export function getSetting(key: string, fallback = ''): string {
  return settingCache.get(key) ?? fallback;
}

export function setRuntimeSecret(key: string, value: string): void {
  if (value) runtimeSecrets.set(key, value);
  else runtimeSecrets.delete(key);
}

export function getRuntimeSecret(key: string): string {
  return runtimeSecrets.get(key) ?? '';
}

export async function setSettings(values: Record<string, string>): Promise<void> {
  const client = requireSupabase();
  const safe = Object.entries(values).filter(([key]) => !secretSetting.test(key));
  if (safe.length) {
    const { error } = await client.from('system_settings').upsert(
      safe.map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() })),
      { onConflict: 'key' }
    );
    if (error) throw new Error(`Unable to save Supabase system_settings: ${error.message}`);
    for (const [key, value] of safe) settingCache.set(key, value);
  }
}

export async function getRemoteSetting(key: string, fallback = ''): Promise<string> {
  const { data, error } = await requireSupabase().from('system_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`Unable to read Supabase setting: ${error.message}`);
  if (data) {
    const value = String(data.value ?? '');
    if (!secretSetting.test(key)) settingCache.set(key, value);
    return value;
  }
  return fallback;
}

export async function logActivity(params: {
  adminId?: number | null;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details: string;
  ipAddress?: string | null;
}): Promise<void> {
  const { error } = await requireSupabase().from('activity_logs').insert({
    admin_id: params.adminId ?? null,
    admin_email: params.adminEmail,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId == null ? null : String(params.entityId),
    details: params.details,
    ip_address: params.ipAddress ?? null,
  });
  if (error) throw new Error(`Unable to write Supabase activity log: ${error.message}`);
}

export function normalizeCandidate<T extends Record<string, any>>(row: T): T & { offer_generated: number; verification_issues: string | null; last_send_status?: string | null } {
  const issues = row.verification_issues;
  return {
    ...row,
    offer_generated: row.offer_generated ? 1 : 0,
    verification_issues: issues == null ? null : typeof issues === 'string' ? issues : JSON.stringify(issues),
    last_send_status: row.last_send_status ?? null,
  };
}

export function normalizeCcRecipient<T extends Record<string, any>>(row: T): T & { enabled: number; is_default: number } {
  return { ...row, enabled: row.enabled ? 1 : 0, is_default: row.is_default ? 1 : 0 };
}

export function normalizeTemplate<T extends Record<string, any>>(row: T): T & { is_master: number } {
  return { ...row, is_master: row.is_master ? 1 : 0 };
}

export function normalizeCampaign<T extends Record<string, any>>(row: T): T & { cc_emails_json: string } {
  return { ...row, cc_emails_json: typeof row.cc_emails === 'string' ? row.cc_emails : JSON.stringify(row.cc_emails ?? []) };
}
