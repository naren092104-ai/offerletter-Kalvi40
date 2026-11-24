-- Grant the server-only Supabase service_role the minimum CRUD permissions
-- required by the existing Kalvi40 API. This does not disable RLS, add policies,
-- create/alter tables, or grant access to anon/authenticated roles.
GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.activity_logs,
  public.admins,
  public.campaigns,
  public.candidates,
  public.cc_recipients,
  public.email_templates,
  public.password_resets,
  public.send_history,
  public.system_settings
TO service_role;

GRANT USAGE, SELECT ON SEQUENCE
  public.activity_logs_id_seq,
  public.admins_id_seq,
  public.campaigns_id_seq,
  public.candidates_id_seq,
  public.cc_recipients_id_seq,
  public.email_templates_id_seq,
  public.password_resets_id_seq,
  public.send_history_id_seq
TO service_role;
