-- Atomic server-side operations for the existing Kalvi40 runtime.
-- Does not create or alter any tables, disable RLS, or change existing rows.

CREATE OR REPLACE FUNCTION public.kalvi40_create_campaign(
  p_batch_code TEXT,
  p_name TEXT,
  p_subject TEXT,
  p_body TEXT,
  p_cc_emails JSONB,
  p_total_count INTEGER,
  p_valid_count INTEGER,
  p_created_by TEXT,
  p_jobs JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_campaign_id BIGINT;
  v_job JSONB;
BEGIN
  INSERT INTO public.campaigns (
    batch_code, name, subject, body, cc_emails, total_count, valid_count,
    sent_count, failed_count, pending_count, status, created_by
  ) VALUES (
    p_batch_code, p_name, p_subject, p_body, COALESCE(p_cc_emails, '[]'::jsonb),
    p_total_count, p_valid_count, 0, 0, p_valid_count, 'queued', p_created_by
  ) RETURNING id INTO v_campaign_id;

  FOR v_job IN SELECT value FROM jsonb_array_elements(COALESCE(p_jobs, '[]'::jsonb))
  LOOP
    INSERT INTO public.send_history (
      campaign_id, batch_code, candidate_id, candidate_name, candidate_email,
      cc_emails, pdf_filename, subject, body_rendered, status, provider, delivery_status
    ) VALUES (
      v_campaign_id, p_batch_code, (v_job->>'candidate_id')::BIGINT,
      v_job->>'candidate_name', v_job->>'candidate_email',
      COALESCE(v_job->>'cc_emails', ''), v_job->>'pdf_filename',
      v_job->>'subject', v_job->>'body_rendered', 'pending', 'smtp', 'not_sent'
    );
  END LOOP;

  RETURN v_campaign_id;
END;
$$;

REVOKE ALL ON FUNCTION public.kalvi40_create_campaign(TEXT, TEXT, TEXT, TEXT, JSONB, INTEGER, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kalvi40_create_campaign(TEXT, TEXT, TEXT, TEXT, JSONB, INTEGER, INTEGER, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.kalvi40_bulk_upsert_candidates(p_candidates JSONB)
RETURNS SETOF BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_candidate JSONB;
  v_candidate_id BIGINT;
BEGIN
  FOR v_candidate IN SELECT value FROM jsonb_array_elements(COALESCE(p_candidates, '[]'::jsonb))
  LOOP
    INSERT INTO public.candidates (
      candidate_name, school_name, location, district, phone, email, joining_date,
      offer_generated, verification_status, verification_issues, updated_at
    ) VALUES (
      v_candidate->>'candidate_name', v_candidate->>'school_name',
      v_candidate->>'location', v_candidate->>'district', COALESCE(v_candidate->>'phone', ''),
      lower(v_candidate->>'email'), v_candidate->>'joining_date', false, 'unverified', NULL, now()
    )
    ON CONFLICT (email) DO UPDATE SET
      candidate_name = EXCLUDED.candidate_name,
      school_name = EXCLUDED.school_name,
      location = EXCLUDED.location,
      district = EXCLUDED.district,
      phone = EXCLUDED.phone,
      joining_date = EXCLUDED.joining_date,
      offer_generated = false,
      verification_status = 'unverified',
      verification_issues = NULL,
      updated_at = now()
    RETURNING id INTO v_candidate_id;

    RETURN NEXT v_candidate_id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.kalvi40_bulk_upsert_candidates(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kalvi40_bulk_upsert_candidates(JSONB) TO service_role;