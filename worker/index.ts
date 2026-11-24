/**
 * Phase 1 Cloudflare Worker API for Kalvi40.
 * Admin login uses the existing Supabase admins table and custom bcrypt/JWT auth.
 * Other existing Express API routes remain in place and are not yet fully ported.
 */
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

export interface Env {
  JWT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
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

function createPublishableSupabaseClient(env: Env, accessToken?: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Supabase URL or publishable key is not configured.');
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : undefined,
  });
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

    const supabase = createPublishableSupabaseClient(env, token);

    if (url.pathname === '/api/candidates' && request.method === 'GET') {
      const { data, error } = await supabase.from('candidates').select('*').order('id', { ascending: false });
      if (error) return jsonResponse({ error: error.message }, 500, origin);
      return jsonResponse({ items: data, total: data?.length || 0 }, 200, origin);
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

  async queue(batch: { messages: Array<{ body: BulkEmailJob; ack: () => void; retry: () => void }> }, env: Env): Promise<void> {
    const supabase = createPrivilegedSupabaseClient(env);
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        await supabase
          .from('send_history')
          .update({
            status: 'failed',
            delivery_status: 'failed',
            provider: 'smtp',
            error_message: 'Cloudflare Worker queue delivery is disabled; use the existing Express SMTP worker.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.historyId);
        msg.ack();
      } catch (err) {
        await supabase
          .from('send_history')
          .update({
            status: 'failed',
            delivery_status: 'failed',
            provider: 'smtp',
            error_message: err instanceof Error ? err.message : 'Queue execution error',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.historyId);
        msg.retry();
      }
    }
  },
};
