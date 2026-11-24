# Cloudflare Worker Backend Migration Checklist

## Scope and compatibility findings

The active backend is `server/routes-supabase.ts`, mounted by `server/app.ts`; the SQLite implementation in `server/routes.ts` is legacy and is not part of this migration. Keep the existing Supabase schema, rows, administrator records, custom HS256 JWT claims/12-hour expiry, endpoint paths, and JSON contracts. Do not run migrations or deploy as part of this plan.

Node/server dependencies and Worker treatment:

- Express 4 and its body-parser dependency: do not import in the Worker. The existing Express adapter was already found incompatible in this runtime; use the native Fetch handler and explicit JSON/body limits.
- `node:fs`, `node:path`, local PDF/signature directories: unsuitable for durable Worker storage. Replace files with the existing private Supabase Storage bucket; use safe object keys and authenticated downloads. Bundle static artwork/font data or load it from durable storage.
- `nodemailer` and ordinary Node SMTP sockets: do not work as a direct drop-in Worker email transport. Use an HTTP email provider (Brevo is already documented) and store its API credential only as a Worker secret. Existing SMTP settings/passwords cannot be reused as an HTTP API key.
- `node:sqlite`: not Worker-compatible and belongs only to the legacy backend.
- `jsonwebtoken`/`node:crypto`: avoid importing Node JWT code; retain compatible HS256 semantics with Web Crypto (already used in `worker/index.ts`). `crypto.randomBytes` needs a Web Crypto equivalent.
- `pdf-lib`: usable with `Uint8Array` in Workers, but remove filesystem dependencies and use Storage. `pdfjs-dist` text extraction must be verified in the Worker runtime before adopting it; otherwise select a Worker-compatible parser or revise verification without weakening checks.
- `bcryptjs`: pure JavaScript and can be bundled, but test its CPU/runtime cost under Worker limits before retaining it for login/password updates.
- `xlsx`: pure JavaScript but large and memory-intensive; test the import/export paths against Worker bundle, memory, and CPU limits before porting.
- `setTimeout` queue processing is isolate-local and not durable. Use Cloudflare Queues with idempotent jobs, explicit retries, and persisted status transitions.

## Complete active Express endpoint inventory (55 registrations)

- Health/auth (7): `GET /api/health`; `POST /api/auth/login`, `/api/auth/forgot-password`, `/api/auth/reset-password`; `GET /api/auth/me`; `PUT /api/auth/profile`, `/api/auth/password`.
- Dashboard/reports (3): `GET /api/dashboard`, `/api/reports`, `/api/reports/export`.
- Candidates (13): `GET /api/candidates`, `/api/candidates/:id`, `/api/candidates/:id/pdf`, `/api/candidates/:id/verify`; `POST /api/candidates`, `/api/candidates/bulk-delete`, `/api/candidates/bulk-import`, `/api/candidates/:id/generate-pdf`, `/api/candidates/bulk-generate-pdfs`, `/api/candidates/verify-batch`; `PUT /api/candidates/:id`, `/api/candidates/:id/offer-content`; `DELETE /api/candidates/:id`.
- Templates (7): `GET /api/templates/master`, `/api/templates/offer`; `PUT /api/templates/master`, `/api/templates/offer`; `POST /api/templates/master/reset`, `/api/templates/offer/preview-pdf`, `/api/templates/offer/reset`.
- CC (4): `GET /api/cc`; `POST /api/cc`; `PUT /api/cc/:id`; `DELETE /api/cc/:id`.
- Email/campaigns (4): `POST /api/send/individual`; `GET /api/campaigns`, `/api/campaigns/:id`; `POST /api/campaigns`.
- History/logs (6): `GET /api/history`, `/api/history/export`, `/api/logs`; `POST /api/history/:id/retry`, `/api/history/retry-batch`, `/api/history/sync-delivery`.
- Settings (10): `GET /api/settings/general`, `/api/settings/signature`, `/api/settings/email`; `PUT /api/settings/general`, `/api/settings/signature/options`, `/api/settings/email`; `POST /api/settings/signature`, `/api/settings/email/test-connection`, `/api/settings/email/send-test`; `DELETE /api/settings/signature`.
- Import template (1): `GET /api/import/sample-excel`.

Every protected endpoint must verify the application's JWT first, then use a server-only Supabase secret/service-role client. The application JWT is not a Supabase Auth JWT and must never be forwarded to Supabase as its bearer token.

## Phased implementation and acceptance gates

### Phase 0 — Stabilize current Worker routes (in progress)
- [x] Preserve existing login and custom JWT validation behavior.
- [x] Add `GET /api/dashboard` and implement the existing dashboard response shape.
- [x] Repair `GET /api/candidates` by using the privileged server client after app-JWT verification; support existing search/filter/sort/page/all query parameters and normalized fields.
- [x] Run TypeScript and Wrangler dry-run checks; do not deploy.
- [x] Add isolated tests for dashboard, candidates, and missing-auth behavior.
- [ ] Add CORS and database-error-path tests.

### Phase 1 — Worker foundation and read-only routes
- [ ] Centralize auth, CORS, body-size checks, Supabase access, error mapping, and route dispatch.
- [ ] Expand endpoint tests to every path/method, including database failures and all auth cases.
- [x] Port `/auth/me`, `/reports` and export, `/logs`, `/history` and export, `/campaigns` reads, `/cc` reads, master/offer template reads, general/email settings reads, signature read, and sample import workbook.
- [x] Preserve the Express response envelopes, ordering, pagination, filtering, and numeric/boolean normalization for the migrated read routes.
- [x] Port candidate detail and create (`GET /candidates/:id`, `POST /candidates`).

### Phase 2 — Supabase-backed metadata and candidate mutations
- [ ] Port profile/password/reset auth operations without changing the existing account model or JWT contract.
- [ ] Port candidate CRUD, bulk delete/import, CC mutations, templates, general settings, and history retry/sync endpoints.
- [ ] Preserve existing RPC transaction boundaries for bulk import/campaign creation; do not create or alter schema.
- [ ] Add mutation tests using isolated fakes; verify reads do not write and writes target only the intended existing rows.

### Phase 3 — Persistent files, PDF generation, and verification
- [ ] Move generated PDFs and founder signatures to the existing private Supabase Storage bucket; retain backward-compatible filenames/API responses.
- [ ] Port PDF generation using `pdf-lib` over byte arrays and replace local artwork/font filesystem reads with packaged assets.
- [ ] Verify `pdfjs-dist` compatibility or choose a tested Worker-compatible text extraction implementation.
- [ ] Port preview, download, signature upload/options/delete, per-candidate PDF generation, verification, and batch verification.
- [ ] Test storage failures, MIME validation, authorization, large uploads, PDF bytes, and generated/verification status persistence.

### Phase 4 — Email and durable campaign processing
- [ ] Select/configure an HTTP email provider and provision its rotated API credential as a Worker secret (not in `VITE_*`, source, or database plaintext).
- [ ] Implement provider send/test operations while preserving existing email payload/result contracts and CC isolation.
- [ ] Replace timer processing with a configured Cloudflare Queue consumer; use idempotency, retries, recovery, and persisted campaign/history counters.
- [ ] Port individual send, campaign create/read, history retry operations, and test delivery through a provider mock; no real email in tests.

### Phase 5 — Full verification and release readiness
- [ ] Test all 55 registered method/path combinations against the Worker handler; maintain a coverage matrix and do not mark any route complete without passing tests.
- [ ] Run frontend build, TypeScript checks, Worker tests, and Wrangler dry-run; verify built frontend requests retain the same `/api/...` paths and contain no backend credentials.
- [ ] Manually verify production configuration and required secret/binding names without exposing secret values.
- [ ] Wait for explicit deployment approval; no deployment is included in this migration task.

## Current status

Phase 0 and the Phase 1 read-route subset plus candidate detail/create handlers are implemented locally in `worker/index.ts`; they are not deployed. `npm run lint`, `npm run check:worker`, and `npm run test:worker` pass for the implemented subset. Remaining mutations, PDF/storage, email, queue, and exhaustive per-route tests are incomplete. No migrated endpoint is described as production-complete until its endpoint test passes and the approved deployment is verified.
