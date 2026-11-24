import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = './data/kalvi40.db';
const OUTPUT_PATH = './data/supabase-import.sql';
const db = new DatabaseSync(DB_PATH);

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function timestamp(value) {
  if (!value) return 'NULL';
  const date = new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? 'NULL' : literal(date.toISOString());
}

const statements = [
  '-- Kalvi40 SQLite to Supabase migration snapshot',
  'BEGIN;',
];

const admins = db.prepare('SELECT * FROM admins').all();
for (const row of admins) {
  statements.push(`INSERT INTO public.admins (name,email,password_hash,role,designation,phone,last_login_at,created_at,updated_at)
VALUES (${literal(row.name)},${literal(row.email)},${literal(row.password_hash)},${literal(row.role)},${literal(row.designation)},${literal(row.phone)},${timestamp(row.last_login_at)},${timestamp(row.created_at)},${timestamp(row.updated_at)})
ON CONFLICT (email) DO NOTHING;`);
}

const candidates = db.prepare('SELECT * FROM candidates').all();
for (const row of candidates) {
  let issues = 'NULL';
  if (row.verification_issues) {
    try { issues = `'${JSON.stringify(JSON.parse(row.verification_issues)).replace(/'/g, "''")}'::jsonb`; } catch { issues = 'NULL'; }
  }
  statements.push(`INSERT INTO public.candidates (candidate_name,school_name,location,district,email,joining_date,offer_generated,offer_generated_at,offer_filename,verification_status,verification_issues,custom_offer_body,created_at,updated_at)
VALUES (${literal(row.candidate_name)},${literal(row.school_name)},${literal(row.location)},${literal(row.district)},${literal(row.email)},${literal(row.joining_date)},${row.offer_generated ? 'TRUE' : 'FALSE'},${timestamp(row.offer_generated_at)},${literal(row.offer_filename)},${literal(row.verification_status)},${issues},${literal(row.custom_offer_body)},${timestamp(row.created_at)},${timestamp(row.updated_at)})
ON CONFLICT (email) DO NOTHING;`);
}

const templates = db.prepare('SELECT * FROM email_templates').all();
for (const row of templates) {
  statements.push(`INSERT INTO public.email_templates (name,subject,body,is_master,updated_by,updated_at)
SELECT ${literal(row.name)},${literal(row.subject)},${literal(row.body)},${row.is_master ? 'TRUE' : 'FALSE'},${literal(row.updated_by)},${timestamp(row.updated_at)}
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE is_master = TRUE);`);
}

const ccRecipients = db.prepare('SELECT * FROM cc_recipients').all();
for (const row of ccRecipients) {
  statements.push(`INSERT INTO public.cc_recipients (email,label,enabled,is_default,created_at)
VALUES (${literal(row.email)},${literal(row.label)},${row.enabled ? 'TRUE' : 'FALSE'},${row.is_default ? 'TRUE' : 'FALSE'},${timestamp(row.created_at)})
ON CONFLICT (email) DO NOTHING;`);
}

const campaigns = db.prepare('SELECT * FROM campaigns').all();
for (const row of campaigns) {
  let ccJson = '[]';
  try { ccJson = JSON.stringify(JSON.parse(row.cc_emails_json)); } catch { ccJson = '[]'; }
  statements.push(`INSERT INTO public.campaigns (batch_code,name,subject,body,cc_emails,total_count,valid_count,sent_count,failed_count,pending_count,status,created_by,created_at,completed_at)
VALUES (${literal(row.batch_code)},${literal(row.name)},${literal(row.subject)},${literal(row.body)},${literal(ccJson)}::jsonb,${row.total_count},${row.valid_count},${row.sent_count},${row.failed_count},${row.pending_count},${literal(row.status)},${literal(row.created_by)},${timestamp(row.created_at)},${timestamp(row.completed_at)});
`);
}

const history = db.prepare('SELECT * FROM send_history').all();
for (const row of history) {
  statements.push(`INSERT INTO public.send_history (batch_code,candidate_id,candidate_name,candidate_email,cc_emails,pdf_filename,subject,body_rendered,status,provider,provider_message_id,delivery_status,error_message,attempts,sent_at,created_at,updated_at)
VALUES (${literal(row.batch_code)},${row.candidate_id},${literal(row.candidate_name)},${literal(row.candidate_email)},${literal(row.cc_emails)},${literal(row.pdf_filename)},${literal(row.subject)},${literal(row.body_rendered)},${literal(row.status)},${literal(row.provider === 'smtp' ? 'smtp' : 'smtp')},${literal(row.provider_message_id)},${literal(row.delivery_status)},${literal(row.error_message)},${row.attempts},${timestamp(row.sent_at)},${timestamp(row.created_at)},${timestamp(row.updated_at)});`);
}

const activityLogs = db.prepare('SELECT * FROM activity_logs').all();
for (const row of activityLogs) {
  statements.push(`INSERT INTO public.activity_logs (admin_email,action,entity_type,entity_id,details,ip_address,created_at)
VALUES (${literal(row.admin_email)},${literal(row.action)},${literal(row.entity_type)},${literal(row.entity_id)},${literal(row.details)},${literal(row.ip_address)},${timestamp(row.created_at)});`);
}

const secretKeys = new Set(['smtp_pass', 'smtp_password', 'brevo_api_key', 'api_key', 'supabase_service_role_key', 'jwt_secret']);
const settings = db.prepare('SELECT * FROM settings').all();
for (const row of settings) {
  if (secretKeys.has(String(row.key).toLowerCase())) continue;
  statements.push(`INSERT INTO public.system_settings (key,value,updated_at)
VALUES (${literal(row.key)},${literal(row.value)},${timestamp(row.updated_at)})
ON CONFLICT (key) DO NOTHING;`);
}

statements.push('COMMIT;');
fs.writeFileSync(OUTPUT_PATH, statements.join('\n\n') + '\n', 'utf8');
console.log(`Generated ${OUTPUT_PATH}: ${admins.length} admins, ${candidates.length} candidates, ${templates.length} templates, ${ccRecipients.length} CC recipients, ${campaigns.length} campaigns, ${history.length} send-history rows, ${activityLogs.length} activity logs, ${settings.length - secretKeys.size} settings candidates.`);
