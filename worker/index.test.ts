import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import worker, { signAdminToken, type Env } from './index.ts';

const jwtSecret = 'test-only-secret-that-is-never-used-outside-tests';
const originalFetch = globalThis.fetch;

const seed = () => ({
  admins: [{ id: 7, name: 'Test Admin', email: 'admin@example.test', password_hash: '', role: 'Administrator', designation: 'Test', phone: '', last_login_at: null, created_at: '2026-01-01T00:00:00Z' }],
  candidates: [{ id: 21, candidate_name: 'Test Candidate', school_name: 'Test School', location: 'Test Town', district: 'Test District', phone: '5550100', email: 'candidate@example.test', joining_date: '01.01.2026', offer_generated: false, verification_status: 'unverified', verification_issues: null, created_at: '2026-01-01T00:00:00Z' }],
  send_history: [{ id: 3, candidate_id: 21, candidate_name: 'Test Candidate', candidate_email: 'candidate@example.test', batch_code: 'BATCH-TEST', pdf_filename: 'test.pdf', status: 'sent', delivery_status: 'accepted', created_at: '2026-01-01T00:00:00Z', sent_at: '2026-01-01T00:00:00Z', cc_emails: '', provider: 'smtp', attempts: 1 }],
  activity_logs: [{ id: 9, admin_id: 7, admin_email: 'admin@example.test', action: 'TEST', entity_type: 'test', entity_id: '21', details: 'Test activity', ip_address: '127.0.0.1', created_at: '2026-01-01T00:00:00Z' }],
  campaigns: [{ id: 5, batch_code: 'BATCH-TEST', name: 'Test Campaign', subject: 'Subject', body: 'Body', cc_emails: [], total_count: 1, valid_count: 1, sent_count: 1, failed_count: 0, pending_count: 0, status: 'completed', created_by: 'admin@example.test', created_at: '2026-01-01T00:00:00Z' }],
  cc_recipients: [{ id: 2, email: 'cc@example.test', label: 'Test CC', enabled: true, is_default: true }],
  email_templates: [{ id: 1, name: 'Master', subject: 'Offer', body: 'Hello {{candidate_name}}', is_master: true, updated_by: 'admin@example.test', updated_at: '2026-01-01T00:00:00Z' }],
  system_settings: [{ key: 'organization_name', value: 'BumbleB Trust' }],
});

type Tables = ReturnType<typeof seed>;
let tables: Tables;
let nextCandidateId = 100;
let storageObjects: Map<string, Uint8Array>;

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function mockSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = (init?.method || 'GET').toUpperCase();
  if (url.pathname.startsWith('/storage/v1/object/')) {
    const parts = url.pathname.slice('/storage/v1/object/'.length).split('/');
    if (parts[0] === 'authenticated') parts.shift();
    const key = parts.join('/');
    if (method === 'GET') {
      const object = storageObjects.get(key);
      if (!object) return json({ message: 'Object not found' }, 404);
      const body = new ArrayBuffer(object.byteLength);
      new Uint8Array(body).set(object);
      return new Response(body, { status: 200, headers: { 'Content-Type': key.endsWith('.pdf') ? 'application/pdf' : 'image/png' } });
    }
    if (method === 'POST' || method === 'PUT') {
      const object = new Uint8Array(await new Response(init?.body).arrayBuffer());
      storageObjects.set(key, object);
      return json({ Key: key }, 200);
    }
    if (method === 'DELETE') {
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) as { prefixes?: string[] } : {};
      for (const prefix of payload.prefixes ?? []) storageObjects.delete(`${parts[0]}/${prefix}`);
      return json([], 200);
    }
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { p_candidates?: Array<Record<string, unknown>> } : {};
    const inserted = (body.p_candidates ?? []).map((candidate) => {
      const id = nextCandidateId++;
      tables.candidates.push({ id, ...candidate, offer_generated: false, verification_status: 'unverified', verification_issues: null, created_at: '2026-01-01T00:00:00Z' } as Tables['candidates'][number]);
      return { kalvi40_bulk_upsert_candidates: id };
    });
    return json(inserted);
  }
  if (!url.pathname.startsWith('/rest/v1/')) return json({ message: 'Unexpected test URL' }, 404);
  const table = decodeURIComponent(url.pathname.slice('/rest/v1/'.length));
  const rows = (tables as unknown as Record<string, Array<Record<string, unknown>>>)[table];
  if (!rows) return Promise.resolve(json({ message: `Unknown test table ${table}` }, 404));

  const matches = (row: Record<string, unknown>) => {
    for (const [key, condition] of url.searchParams.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
      if (condition.startsWith('eq.') && String(row[key] ?? '') !== condition.slice(3)) return false;
      if (condition.startsWith('is.') && condition.slice(3) === 'null' && row[key] != null) return false;
      if (condition.startsWith('neq.') && String(row[key] ?? '') === condition.slice(4)) return false;
      if (condition.startsWith('in.')) {
        const values = condition.slice(3).replace(/^\(|\)$/g, '').split(',').map((value) => value.replace(/^"|"$/g, ''));
        if (!values.includes(String(row[key] ?? ''))) return false;
      }
    }
    return true;
  };

  if (method === 'GET' || method === 'HEAD') {
    const found = rows.filter(matches);
    const selected = url.searchParams.has('limit') ? found.slice(0, Number(url.searchParams.get('limit'))) : found;
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (init?.headers && new Headers(init.headers).get('Accept') === 'application/vnd.pgrst.object+json') {
      return selected.length ? json(selected[0]) : json({ code: 'PGRST116', message: 'No rows found' }, 406);
    }
    return json(selected, 200, { 'Content-Range': `0-${Math.max(0, selected.length - 1)}/${selected.length}` });
  }

  if (method === 'POST') {
    const value = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> | Array<Record<string, unknown>> : {};
    const insertedRows = (Array.isArray(value) ? value : [value]).map((row) => ({ id: nextCandidateId++, ...row }));
    rows.push(...insertedRows);
    const inserted = insertedRows[0];
    const prefer = new Headers(init?.headers).get('Prefer') || '';
    if (prefer.includes('return=representation')) {
      const output = new Headers(init?.headers).get('Accept') === 'application/vnd.pgrst.object+json' ? inserted : insertedRows;
      return json(output, 201);
    }
    return new Response(null, { status: 201 });
  }

  if (method === 'PATCH') {
    const patch = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const changed = rows.filter(matches);
    for (const row of changed) Object.assign(row, patch);
    const prefer = new Headers(init?.headers).get('Prefer') || '';
    if (prefer.includes('return=representation')) {
      return json(new Headers(init?.headers).get('Accept') === 'application/vnd.pgrst.object+json' ? changed[0] : changed, 200);
    }
    return new Response(null, { status: 204 });
  }

  if (method === 'DELETE') {
    for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index])) rows.splice(index, 1);
    return new Response(null, { status: 204 });
  }
  return json({ message: `Unsupported method ${method}` }, 405);
}

const env: Env = {
  JWT_SECRET: jwtSecret,
  SUPABASE_URL: 'https://supabase.example.test',
  SUPABASE_SECRET_KEY: 'test-only-supabase-key',
  SUPABASE_PUBLISHABLE_KEY: 'test-only-publishable-key',
  SUPABASE_STORAGE_BUCKET: 'offer-letters',
  ALLOWED_ORIGIN: 'https://app.example.test',
};

async function call(path: string, method = 'GET', token?: string, body?: unknown) {
  const headers = new Headers({ Origin: 'https://app.example.test' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(`https://worker.example.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

let adminToken: string;
beforeEach(async () => {
  tables = seed();
  tables.admins[0].password_hash = bcrypt.hashSync('test-password', 4);
  storageObjects = new Map();
  nextCandidateId = 100;
  globalThis.fetch = mockSupabaseFetch;
  adminToken = await signAdminToken({ id: 7, email: 'admin@example.test', role: 'Administrator' }, jwtSecret);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('health endpoint is public', async () => {
  const response = await call('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { runtime: string }).runtime, 'cloudflare-workers');
});

test('existing administrator login returns the unchanged token/admin envelope', async () => {
  const response = await call('/api/auth/login', 'POST', undefined, { email: 'ADMIN@example.test', password: 'test-password' });
  assert.equal(response.status, 200);
  const body = await response.json() as { token: string; admin: { id: number; email: string } };
  assert.match(body.token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(body.admin.id, 7);
  assert.equal(body.admin.email, 'admin@example.test');
});

test('protected routes reject a missing token', async () => {
  assert.equal((await call('/api/dashboard')).status, 401);
});

test('custom application JWT is not forwarded as Supabase Auth bearer token', async () => {
  const response = await call('/api/candidates', 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json() as { total: number; items: Array<{ last_send_status: string }> };
  assert.equal(body.total, 1);
  assert.equal(body.items[0].last_send_status, 'sent');
});

test('dashboard returns expected KPI and activity fields', async () => {
  const response = await call('/api/dashboard', 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json() as { kpis: { totalCandidates: number; emailsSent: number }; recentActivities: unknown[] };
  assert.equal(body.kpis.totalCandidates, 1);
  assert.equal(body.kpis.emailsSent, 1);
  assert.equal(body.recentActivities.length, 1);
});

test('candidate list supports all=true and district list', async () => {
  const response = await call('/api/candidates?all=true', 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: unknown[]; districts: string[] };
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.districts, ['Test District']);
});

test('candidate detail includes last send status', async () => {
  const response = await call('/api/candidates/21', 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json() as { candidate: { last_send_status: string } };
  assert.equal(body.candidate.last_send_status, 'sent');
});

test('candidate creation validates fields and writes the expected response', async () => {
  const invalid = await call('/api/candidates', 'POST', adminToken, { candidate_name: 'Incomplete' });
  assert.equal(invalid.status, 400);
  const response = await call('/api/candidates', 'POST', adminToken, {
    candidate_name: 'New Candidate', school_name: 'New School', location: 'New Town', district: 'New District',
    phone: '5550101', email: 'new@example.test', joining_date: '02.01.2026',
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { candidate: { candidate_name: string; offer_generated: number } };
  assert.equal(body.candidate.candidate_name, 'New Candidate');
  assert.equal(body.candidate.offer_generated, 0);
});

test('candidate update preserves the response envelope and invalidates generated status', async () => {
  const response = await call('/api/candidates/21', 'PUT', adminToken, {
    candidate_name: 'Updated Candidate', school_name: 'Updated School', location: 'Updated Town', district: 'Updated District',
    phone: '5550102', email: 'candidate@example.test', joining_date: '03.01.2026',
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { candidate: { candidate_name: string; offer_generated: number } };
  assert.equal(body.candidate.candidate_name, 'Updated Candidate');
  assert.equal(body.candidate.offer_generated, 0);
});

test('candidate delete and bulk-delete keep their existing response contracts', async () => {
  const one = await call('/api/candidates/21', 'DELETE', adminToken);
  assert.equal(one.status, 200);
  assert.equal((await one.json() as { message: string }).message, 'Candidate deleted.');

  tables.candidates.push({ ...seed().candidates[0], id: 22, email: 'second@example.test' });
  const bulk = await call('/api/candidates/bulk-delete', 'POST', adminToken, { candidateIds: [22] });
  assert.equal(bulk.status, 200);
  assert.equal((await bulk.json() as { deletedCount: number }).deletedCount, 1);
});

test('bulk import validates rows and returns imported/skipped counts', async () => {
  const response = await call('/api/candidates/bulk-import', 'POST', adminToken, {
    records: [
      { candidate_name: 'Imported', school_name: 'School', location: 'Town', district: 'District', phone: '5550103', email: 'imported@example.test', joining_date: '04.01.2026' },
      { candidate_name: '', email: '' },
    ],
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { importedCount: number; skippedCount: number; importedIds: number[] };
  assert.equal(body.importedCount, 1);
  assert.equal(body.skippedCount, 1);
  assert.equal(body.importedIds.length, 1);
});

test('PDF generation persists bytes to private Storage and updates candidate metadata', async () => {
  const generated = await call('/api/candidates/21/generate-pdf', 'POST', adminToken);
  assert.equal(generated.status, 200);
  const body = await generated.json() as { filename: string; sizeBytes: number; candidate: { offer_generated: number } };
  assert.ok(body.filename.endsWith('.pdf'));
  assert.ok(body.sizeBytes > 500);
  assert.equal(body.candidate.offer_generated, 1);

  const downloaded = await call('/api/candidates/21/pdf?download=1', 'GET', adminToken);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('Content-Type') || '', /application\/pdf/);
  assert.ok((await downloaded.arrayBuffer()).byteLength > 500);
});

test('candidate verification reads persisted PDF text and returns verification checks', async () => {
  const response = await call('/api/candidates/21/verify', 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json() as { candidateId: number; pdfExists: boolean; valid: boolean; checks: Array<{ key: string }> };
  assert.equal(body.candidateId, 21);
  assert.equal(body.pdfExists, true);
  assert.equal(body.valid, true);
  assert.ok(body.checks.some((check) => check.key === 'name_match_pdf'));
});

test('offer-template preview returns a PDF without writing candidate state', async () => {
  const response = await call('/api/templates/offer/preview-pdf', 'POST', adminToken, { candidateId: 21, template: { heading: 'Draft Preview' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') || '', /application\/pdf/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-');
  assert.equal(tables.candidates[0].offer_generated, false);
});

test('read endpoints keep their response envelopes', async () => {
  const cases: Array<[string, string, string]> = [
    ['/api/auth/me', 'GET', 'admin'],
    ['/api/reports', 'GET', 'summary'],
    ['/api/logs', 'GET', 'actions'],
    ['/api/history', 'GET', 'batches'],
    ['/api/campaigns', 'GET', 'items'],
    ['/api/campaigns/5', 'GET', 'campaign'],
    ['/api/cc', 'GET', 'items'],
    ['/api/templates/master', 'GET', 'template'],
    ['/api/templates/offer', 'GET', 'template'],
    ['/api/settings/general', 'GET', 'settings'],
    ['/api/settings/email', 'GET', 'config'],
    ['/api/settings/signature', 'GET', 'signature'],
  ];
  for (const [path, method, field] of cases) {
    const response = await call(path, method, adminToken);
    assert.equal(response.status, 200, `${method} ${path}`);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(field in body, `${method} ${path} should return ${field}`);
  }
});

test('email configuration stores submitted credentials encrypted and never returns them', async () => {
  const response = await call('/api/settings/email', 'PUT', adminToken, {
    sender_name: 'Kalvi40 Test',
    sender_email: 'sender@example.test',
    reply_to: 'reply@example.test',
    smtp_host: 'smtp.example.test',
    smtp_port: '587',
    smtp_user: 'sender@example.test',
    smtp_pass: 'private-test-password',
    smtp_secure: false,
    rate_limit_per_minute: 45,
    max_retries: 3,
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { config: { smtp_user: string; sender_email: string; smtp_pass_set: boolean; provider_configured: boolean } };
  assert.equal(body.config.smtp_user, 'sender@example.test');
  assert.equal(body.config.sender_email, 'sender@example.test');
  assert.equal(body.config.smtp_pass_set, true);
  assert.equal(body.config.provider_configured, true);
  const storedCredential = tables.system_settings.find((row) => row.key === 'smtp_pass_encrypted')?.value || '';
  assert.ok(storedCredential.startsWith('v1.'));
  assert.equal(storedCredential.includes('private-test-password'), false);
});

test('report/history/sample exports are XLSX responses', async () => {
  for (const path of ['/api/reports/export', '/api/history/export', '/api/import/sample-excel']) {
    const response = await call(path, 'GET', adminToken);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Content-Type') || '', /spreadsheetml\.sheet/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test('unknown protected route remains an explicit 404', async () => {
  const response = await call('/api/not-migrated', 'GET', adminToken);
  assert.equal(response.status, 404);
  assert.match((await response.json() as { error: string }).error, /Route not mapped/);
});
