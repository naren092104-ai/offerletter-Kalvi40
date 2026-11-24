-- ============================================================================
-- KALVI40 — ENTERPRISE OFFER LETTER & BULK EMAIL AUTOMATION SYSTEM
-- Supabase PostgreSQL Initial Schema Migration (001_initial_schema.sql)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. ADMINISTRATORS
CREATE TABLE IF NOT EXISTS public.admins (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Administrator',
  designation TEXT NOT NULL DEFAULT 'Coordinator, Accounts & Admin',
  phone TEXT NOT NULL DEFAULT '+91 97910 07318',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. PASSWORD RESET TOKENS
CREATE TABLE IF NOT EXISTS public.password_resets (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CANDIDATES
CREATE TABLE IF NOT EXISTS public.candidates (
  id BIGSERIAL PRIMARY KEY,
  candidate_name TEXT NOT NULL,
  school_name TEXT NOT NULL,
  location TEXT NOT NULL,
  district TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  joining_date TEXT NOT NULL,
  offer_generated BOOLEAN NOT NULL DEFAULT FALSE,
  offer_generated_at TIMESTAMPTZ,
  offer_filename TEXT,
  offer_storage_path TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  verification_issues JSONB,
  custom_offer_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_email ON public.candidates (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_candidates_district ON public.candidates (district);

-- 4. MASTER EMAIL TEMPLATES
CREATE TABLE IF NOT EXISTS public.email_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  is_master BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. CC RECIPIENTS
CREATE TABLE IF NOT EXISTS public.cc_recipients (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. BULK CAMPAIGNS
CREATE TABLE IF NOT EXISTS public.campaigns (
  id BIGSERIAL PRIMARY KEY,
  batch_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'completed_with_errors', 'paused')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 7. INDIVIDUAL SEND HISTORY / QUEUE ITEMS
CREATE TABLE IF NOT EXISTS public.send_history (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT REFERENCES public.campaigns(id) ON DELETE SET NULL,
  batch_code TEXT NOT NULL,
  candidate_id BIGINT NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  candidate_email TEXT NOT NULL,
  cc_emails TEXT NOT NULL DEFAULT '',
  pdf_filename TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_rendered TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  provider TEXT NOT NULL DEFAULT 'smtp',
  provider_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'not_sent'
    CHECK (delivery_status IN ('not_sent', 'accepted', 'delivered', 'bounced', 'failed')),
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_send_history_status ON public.send_history (status);
CREATE INDEX IF NOT EXISTS idx_send_history_batch ON public.send_history (batch_code);
CREATE INDEX IF NOT EXISTS idx_send_history_candidate ON public.send_history (candidate_id);

-- 8. ACTIVITY AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT REFERENCES public.admins(id) ON DELETE SET NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs (created_at DESC);

-- 9. SYSTEM SETTINGS (API KEYS STORED ONLY IN WORKER SECRETS OR ENCRYPTED VAULT)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. ROW LEVEL SECURITY (Serverless Worker uses service_role key; deny direct anon access)
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cc_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Compatibility view for the existing Express settings API name.
CREATE OR REPLACE VIEW public.settings AS
SELECT key, value, updated_at FROM public.system_settings;

-- 11. SUPABASE STORAGE BUCKET FOR OFFER LETTER PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('offer-letters', 'offer-letters', FALSE)
ON CONFLICT (id) DO NOTHING;

-- 12. DEFAULT MASTER EMAIL TEMPLATE SEED
INSERT INTO public.email_templates (name, subject, body, is_master, updated_by)
SELECT
  'Master Appointment Offer Email',
  'Congratulations on Your Appointment – Teaching Coordinator',
  E'Dear {{candidate_name}},\n\nGreetings from BumbleB Trust - Kalvi40.\n\nCongratulations on your appointment as the Teaching Coordinator at {{school_name}}, {{location}}, {{district}}.\n\nPlease find your offer letter attached. The physical copy and your welcome kit are being prepared and will be sent to you shortly.\n\nWe look forward to your contributions to the team. In the meantime, we encourage you to install the Kalvi40 app on your Android device and follow our social media pages.\n\nWe wish you all the best in your new role.\n\nBest regards,\n\nS. Sankareswari\nCoordinator, Accounts & Admin',
  TRUE,
  'System Migration'
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE is_master = TRUE);
