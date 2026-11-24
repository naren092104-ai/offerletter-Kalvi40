import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import {
  DEFAULT_MASTER_BODY,
  DEFAULT_MASTER_SUBJECT,
  DEFAULT_OFFER_LETTER_TEMPLATE,
} from '../src/types/kalvi40.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'kalvi40.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
export const pdfStorageDir = PDF_DIR;
export const uploadsStorageDir = UPLOADS_DIR;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Administrator',
    designation TEXT NOT NULL DEFAULT 'Coordinator, Accounts & Admin',
    phone TEXT NOT NULL DEFAULT '+91 97910 07318',
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_name TEXT NOT NULL,
    school_name TEXT NOT NULL,
    location TEXT NOT NULL,
    district TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    joining_date TEXT NOT NULL,
    offer_generated INTEGER NOT NULL DEFAULT 0,
    offer_generated_at TEXT,
    offer_filename TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    verification_issues TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    is_master INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cc_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    cc_emails_json TEXT NOT NULL DEFAULT '[]',
    total_count INTEGER NOT NULL DEFAULT 0,
    valid_count INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    pending_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS send_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    batch_code TEXT NOT NULL,
    candidate_id INTEGER NOT NULL,
    candidate_name TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    cc_emails TEXT NOT NULL DEFAULT '',
    pdf_filename TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_rendered TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider TEXT NOT NULL DEFAULT 'unconfigured',
    provider_message_id TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'not_sent',
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT NOT NULL,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);
  CREATE INDEX IF NOT EXISTS idx_candidates_district ON candidates(district);
  CREATE INDEX IF NOT EXISTS idx_send_history_status ON send_history(status);
  CREATE INDEX IF NOT EXISTS idx_send_history_batch ON send_history(batch_code);
  CREATE INDEX IF NOT EXISTS idx_send_history_candidate ON send_history(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
`);

// Safe incremental schema migrations for existing SQLite databases
const candidateCols = db.prepare(`PRAGMA table_info(candidates)`).all() as Array<{ name: string }>;
if (!candidateCols.some((c) => c.name === 'custom_offer_body')) {
  db.exec(`ALTER TABLE candidates ADD COLUMN custom_offer_body TEXT`);
}
if (!candidateCols.some((c) => c.name === 'phone')) {
  db.exec(`ALTER TABLE candidates ADD COLUMN phone TEXT NOT NULL DEFAULT ''`);
}

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function logActivity(params: {
  adminId?: number | null;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details: string;
  ipAddress?: string | null;
}): void {
  db.prepare(`
    INSERT INTO activity_logs (admin_id, admin_email, action, entity_type, entity_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.adminId ?? null,
    params.adminEmail,
    params.action,
    params.entityType,
    params.entityId != null ? String(params.entityId) : null,
    params.details,
    params.ipAddress ?? null
  );
}

export function seedInitialData(): void {
  const adminCount = (db.prepare('SELECT COUNT(*) as cnt FROM admins').get() as { cnt: number }).cnt;
  if (adminCount === 0) {
    const defaultEmail = process.env.ADMIN_DEFAULT_EMAIL || 'admin@bumbleb.org.in';
    const defaultName = process.env.ADMIN_DEFAULT_NAME || 'S. Sankareswari';
    const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'Kalvi40@2026';
    const hash = bcrypt.hashSync(defaultPassword, 10);
    db.prepare(`
      INSERT INTO admins (name, email, password_hash, role, designation, phone)
      VALUES (?, ?, ?, 'Super Administrator', 'Coordinator, Accounts & Admin', '+91 97910 07318')
    `).run(defaultName, defaultEmail.toLowerCase(), hash);
  }

  const templateCount = (db.prepare('SELECT COUNT(*) as cnt FROM email_templates').get() as { cnt: number }).cnt;
  if (templateCount === 0) {
    db.prepare(`
      INSERT INTO email_templates (name, subject, body, is_master, updated_by)
      VALUES ('Master Appointment Offer Email', ?, ?, 1, 'System Seed')
    `).run(DEFAULT_MASTER_SUBJECT, DEFAULT_MASTER_BODY);
  }

  const ccCount = (db.prepare('SELECT COUNT(*) as cnt FROM cc_recipients').get() as { cnt: number }).cnt;
  if (ccCount === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO cc_recipients (email, label, enabled, is_default)
      VALUES (?, ?, 1, 1)
    `).run('prem@bumbleb.org.in', 'Managing Trustee');
  }

  const defaultSettings: Record<string, string> = {
    organization_name: 'BumbleB Trust',
    program_name: 'Kalvi40',
    contract_end_date: DEFAULT_OFFER_LETTER_TEMPLATE.contract_end_date,
    stipend_text: DEFAULT_OFFER_LETTER_TEMPLATE.stipend_text,
    offer_header_name: DEFAULT_OFFER_LETTER_TEMPLATE.header_name,
    offer_header_role: DEFAULT_OFFER_LETTER_TEMPLATE.header_role,
    offer_brand_title: DEFAULT_OFFER_LETTER_TEMPLATE.brand_title,
    offer_brand_subtitle: DEFAULT_OFFER_LETTER_TEMPLATE.brand_subtitle,
    offer_heading: DEFAULT_OFFER_LETTER_TEMPLATE.heading,
    offer_greeting: DEFAULT_OFFER_LETTER_TEMPLATE.greeting,
    offer_body: DEFAULT_OFFER_LETTER_TEMPLATE.body,
    offer_closing: DEFAULT_OFFER_LETTER_TEMPLATE.closing,
    offer_signatory_title: DEFAULT_OFFER_LETTER_TEMPLATE.signatory_title,
    offer_signatory_org: DEFAULT_OFFER_LETTER_TEMPLATE.signatory_org,
    offer_footer_left_url: DEFAULT_OFFER_LETTER_TEMPLATE.footer_left_url,
    offer_footer_right_url: DEFAULT_OFFER_LETTER_TEMPLATE.footer_right_url,
    offer_body_font_size: String(DEFAULT_OFFER_LETTER_TEMPLATE.body_font_size),
    founder_signature_filename: '',
    founder_signature_mime: '',
    founder_signature_height: '40',
    founder_signature_updated_at: '',
    trust_address: 'No.63, 2nd Main Road, Sankarapuram, Sithalapakkam, Chennai - 600126.',
    trust_regn: '(A Public Charitable Trust / Regn. No.125 /2019 BKIV)',
    trust_mobile: '+91 97910 07318',
    trust_email: 'prem@bumbleb.org.in',
    trust_website: 'www.bumbleb.org.in',
    email_provider: 'smtp',
    sender_name: process.env.SMTP_SENDER_NAME || 'BumbleB Trust - Kalvi40',
    sender_email: process.env.SMTP_SENDER_EMAIL || process.env.SMTP_USER || 'prem@bumbleb.org.in',
    reply_to: process.env.SMTP_SENDER_EMAIL || process.env.SMTP_USER || 'prem@bumbleb.org.in',
    smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    smtp_secure: process.env.SMTP_SECURE || 'false',
    rate_limit_per_minute: '45',
    max_retries: '3',
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
    if (!existing) {
      setSetting(k, v);
    }
  }

  // Enforce SMTP-only transport and migrate any legacy Brevo defaults
  if (getSetting('email_provider', 'smtp') !== 'smtp') {
    setSetting('email_provider', 'smtp');
  }
  if (getSetting('smtp_host', '') === 'smtp-relay.brevo.com') {
    setSetting('smtp_host', 'smtp.gmail.com');
  }
  db.prepare(`DELETE FROM settings WHERE key = 'brevo_api_key'`).run();

  // Seed initial reference candidates once on first-ever database creation
  const candidateCount = (db.prepare('SELECT COUNT(*) as cnt FROM candidates').get() as { cnt: number }).cnt;
  const alreadySeeded = getSetting('initial_candidates_seeded', '0') === '1';
  if (candidateCount === 0 && !alreadySeeded) {
    const starterCandidates = [
      {
        candidate_name: 'E Sathiya Kaviya',
        school_name: 'Govt Panchayat Union Middle School',
        location: 'Pattiyandal',
        district: 'Tiruvannamalai',
        email: 'kaviya132052@gmail.com',
        joining_date: '21.10.2026',
      },
      {
        candidate_name: 'R Karthikeyan',
        school_name: 'Govt High School',
        location: 'Polur',
        district: 'Tiruvannamalai',
        email: 'karthikeyan.kalvi40.demo@example.org',
        joining_date: '21.10.2026',
      },
      {
        candidate_name: 'M Priyadharshini',
        school_name: 'Panchayat Union Primary School',
        location: 'Sithalapakkam',
        district: 'Chengalpattu',
        email: 'priyadharshini.kalvi40.demo@example.org',
        joining_date: '24.10.2026',
      },
      {
        candidate_name: 'S Aravindhan',
        school_name: 'Govt Higher Secondary School',
        location: 'Villupuram Town',
        district: 'Villupuram',
        email: 'aravindhan.kalvi40.demo@example.org',
        joining_date: '26.10.2026',
      },
      {
        candidate_name: 'K Nithya Devi',
        school_name: 'Govt Middle School',
        location: 'Arakkonam',
        district: 'Ranipet',
        email: 'nithya.kalvi40.demo@example.org',
        joining_date: '28.10.2026',
      },
      {
        candidate_name: 'V Vigneshwaran',
        school_name: 'Corporation Middle School',
        location: 'Tambaram',
        district: 'Chennai',
        email: 'vignesh.kalvi40.demo@example.org',
        joining_date: '02.11.2026',
      },
    ];

    const insertStmt = db.prepare(`
      INSERT INTO candidates (candidate_name, school_name, location, district, email, joining_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of starterCandidates) {
      insertStmt.run(c.candidate_name, c.school_name, c.location, c.district, c.email, c.joining_date);
    }
    setSetting('initial_candidates_seeded', '1');
  } else if (candidateCount > 0 && !alreadySeeded) {
    setSetting('initial_candidates_seeded', '1');
  }
}

seedInitialData();
