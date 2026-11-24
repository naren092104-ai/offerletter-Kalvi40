# Kalvi40 — Deployment Guide & API Reference

## 1. Architecture Summary
- **Frontend**: React + TypeScript + Vite + Tailwind CSS (deployable to **Cloudflare Pages**)
- **Backend**:
  - **Local / Container / Node Runtime**: Express + SQLite (`node:sqlite`) in `server.ts` with persistent background job queue (`server/queue.ts`) and pure-JS `pdf-lib` PDF generation (`server/pdfGenerator.ts`).
  - **Serverless Production**: **Cloudflare Workers** (`worker/index.ts` + `wrangler.toml`) backed by **Supabase PostgreSQL** (`supabase/migrations/001_initial_schema.sql`) and **Supabase Storage** (`offer-letters` bucket).
- **Email Delivery**: **Brevo Transactional Email API** (`https://api.brevo.com/v3/smtp/email`) or any compatible SMTP relay (`smtp-relay.brevo.com:587`).

---

## 2. Supabase Setup (Free Tier)
1. Create a free Supabase project at https://supabase.com.
2. Open **SQL Editor** and execute `/supabase/migrations/001_initial_schema.sql`.
3. Verify the private storage bucket `offer-letters` was created under **Storage**.
4. Copy `Project URL` (`SUPABASE_URL`), `anon public` key (`SUPABASE_ANON_KEY`), and `service_role` secret key (`SUPABASE_SERVICE_ROLE_KEY`).
   > **Security**: Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code or `VITE_*` variables.

---

## 3. Brevo Email Configuration (Free Tier: 300 emails/day)
1. Sign up at https://www.brevo.com (Free plan allows 300 transactional emails/day).
2. Add and verify your sending domain (`bumbleb.org.in` or `kalvi40.com`) under **Senders, Domains & Dedicated IPs**:
   - Configure SPF (`v=spf1 include:spf.brevo.com ~all`) and DKIM TXT records in your DNS provider (Cloudflare DNS).
3. Generate an **API v3 Key** under **SMTP & API -> API Keys**.
4. Enter the API key in **Settings -> Email Configuration** inside the Kalvi40 Admin Console (or set `BREVO_API_KEY` in `.env` / Wrangler secrets), then click **Test Connection**.
5. For batches larger than 300 candidates on the free tier, set **Rate Limit** conservatively and schedule batches across days, or upgrade Brevo Starter as needed.

---

## 4. Cloudflare Deployment
### A. Cloudflare Workers (Backend)
```bash
npm install -g wrangler
wrangler login
wrangler queues create kalvi40-email-queue
wrangler secret put JWT_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put BREVO_API_KEY
wrangler deploy
```

### B. Cloudflare Pages (Frontend)
1. Connect repository to Cloudflare Pages.
2. Build command: `npm run build`
3. Build output directory: `dist`
4. Set environment variable `VITE_API_BASE_URL` pointing to your deployed Worker URL (if hosted on a separate subdomain).

---

## 5. REST API Reference
All protected routes require `Authorization: Bearer <jwt_token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Admin email/password login returning JWT |
| `POST` | `/api/auth/forgot-password` | Generate 30-min reset token & send email |
| `POST` | `/api/auth/reset-password` | Reset admin password with valid token |
| `GET` | `/api/auth/me` | Current authenticated admin profile |
| `PUT` | `/api/auth/profile` | Update admin name, designation, phone, email |
| `PUT` | `/api/auth/password` | Change administrator password |
| `GET` | `/api/dashboard` | KPI counts, monthly activity, district distribution |
| `GET/POST` | `/api/candidates` | List/filter/paginate or create candidate |
| `PUT/DELETE` | `/api/candidates/:id` | Update or remove candidate |
| `POST` | `/api/candidates/bulk-import` | Transactionally import validated Excel/CSV rows |
| `POST` | `/api/candidates/:id/generate-pdf` | Generate `Offer_Letter_<Name>.pdf` |
| `POST` | `/api/candidates/bulk-generate-pdfs` | Generate PDFs for selected/all candidates |
| `GET` | `/api/candidates/:id/pdf` | Stream (`?inline=1`) or download (`?download=1`) PDF |
| `GET` | `/api/candidates/:id/verify` | Cross-verify DB vs Email vs PDF binary text |
| `POST` | `/api/candidates/verify-batch` | Batch verification before bulk sending |
| `GET/PUT` | `/api/templates/master` | Read or update master email template |
| `POST` | `/api/templates/master/reset` | Reset master template to Kalvi40 default |
| `GET/POST/PUT/DELETE` | `/api/cc` | Manage global & default CC recipients |
| `POST` | `/api/send/individual` | Verify and send a single offer letter email |
| `GET/POST` | `/api/campaigns` | List campaigns or launch queued bulk campaign |
| `GET` | `/api/campaigns/:id` | Live progress & deliveries for a batch |
| `GET` | `/api/history` | Searchable, filterable sending history |
| `POST` | `/api/history/:id/retry` | Retry a single failed delivery |
| `POST` | `/api/history/retry-batch` | Retry all failed deliveries in a batch |
| `POST` | `/api/history/sync-delivery` | Poll Brevo events (Accepted vs Delivered/Bounced) |
| `GET` | `/api/history/export` | Export sending history as `.xlsx` |
| `GET` | `/api/reports` & `/api/reports/export` | District/School/Monthly analytics & multi-sheet `.xlsx` |
| `GET` | `/api/logs` | Audit trail of all administrative actions |
| `GET/PUT` | `/api/settings/general` | Organization, stipend & contract end date config |
| `GET/PUT` | `/api/settings/email` | Brevo/SMTP credentials & rate limit config |
| `POST` | `/api/settings/email/test-connection` | Live verify Brevo API or SMTP handshake |
| `POST` | `/api/settings/email/send-test` | Send sample PDF offer email to admin address |
