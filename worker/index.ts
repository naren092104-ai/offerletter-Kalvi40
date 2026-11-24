/**
 * Cloudflare Worker Supabase API + Queue Stub for Kalvi40
 * Supabase PostgreSQL and Storage use publishable/secret bindings; SMTP sending remains in the existing Express runtime.
 */
import { createClient } from '@supabase/supabase-js';

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

function corsHeaders(origin = '*'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
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

function createPrivilegedSupabaseClient(env: Env) {
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
  });
}

async function probeSupabaseDatabase(env: Env): Promise<{ reachable: boolean; database: 'connected' | 'verification_pending'; detail: 'configured' | 'missing_configuration' | 'api_error' | 'table_missing' }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { reachable: false, database: 'verification_pending', detail: 'missing_configuration' };
  }

  try {
    const supabase = createPublishableSupabaseClient(env);
    const { error, status } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    if (!error) {
      return { reachable: true, database: 'connected', detail: 'configured' };
    }

    const missingTable = error.code === 'PGRST205' || status === 404;
    return {
      reachable: true,
      database: 'verification_pending',
      detail: missingTable ? 'table_missing' : 'api_error',
    };
  } catch {
    return { reachable: false, database: 'verification_pending', detail: 'api_error' };
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
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', runtime: 'cloudflare-workers' }, 200, origin);
    }

    if (url.pathname === '/api/health/supabase' && request.method === 'GET') {
      const probe = await probeSupabaseDatabase(env);
      if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
        return jsonResponse({
          success: false,
          database: 'verification_pending',
          provider: 'supabase',
          error: 'Supabase configuration is incomplete.',
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
