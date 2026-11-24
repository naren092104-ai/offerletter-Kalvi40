import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { db, getSetting, logActivity, pdfStorageDir, setSetting, uploadsStorageDir } from './db.ts';
import {
  getPublicEmailConfig,
  isProviderConfigured,
  isValidSmtpHost,
  normalizeSmtpPassword,
  sendTransactionalOfferEmail,
  verifyEmailProviderConnection,
} from './emailService.ts';
import {
  buildOfferLetterPdfBuffer,
  generateOfferLetterPdf,
  getFounderSignatureInfo,
  getOfferLetterTemplate,
} from './pdfGenerator.ts';
import { triggerQueueWorker } from './queue.ts';
import { getMasterTemplate, verifyCandidateForSending } from './verification.ts';
import {
  deleteCcRecipientFromSupabase,
  deleteCandidatesFromSupabase,
  syncCandidateToSupabase,
  syncCandidatesToSupabase,
  syncCcRecipientToSupabase,
  syncAdminToSupabase,
  syncMasterEmailTemplateToSupabase,
  syncSettingsToSupabase,
} from './supabase.ts';
import {
  DEFAULT_MASTER_BODY,
  DEFAULT_MASTER_SUBJECT,
  DEFAULT_OFFER_LETTER_TEMPLATE,
  formatDateDDMMYYYY,
  normalizeSchoolName,
  renderTemplateString,
  sanitizeOfferFilename,
  type AdminUser,
  type Campaign,
  type Candidate,
  type CcRecipient,
  type SendHistoryRecord,
} from '../src/types/kalvi40.ts';

interface AuthRequest extends Request {
  admin?: AdminUser;
}

async function syncLocalSettingsToSupabase(): Promise<{ ok: boolean; error?: string }> {
  const settings = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  return syncSettingsToSupabase(settings);
}

const JWT_SECRET = process.env.JWT_SECRET || 'kalvi40-bumbleb-enterprise-secret-2026';

function signToken(admin: AdminUser): string {
  return jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET, {
    expiresIn: '12h',
  });
}

function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;

  if (!rawToken) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  try {
    const decoded = jwt.verify(rawToken, JWT_SECRET) as { id: number; email: string };
    const admin = db
      .prepare('SELECT id, name, email, role, designation, phone, last_login_at, created_at FROM admins WHERE id = ?')
      .get(decoded.id) as AdminUser | undefined;

    if (!admin) {
      res.status(401).json({ error: 'Administrator session is invalid or expired.' });
      return;
    }
    req.admin = admin;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // =========================================================================
  // HEALTH & AUTHENTICATION
  // =========================================================================
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'kalvi40-offer-automation', timestamp: new Date().toISOString() });
  });

  router.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const row = db.prepare('SELECT * FROM admins WHERE email = ?').get(email) as
      | (AdminUser & { password_hash: string })
      | undefined;

    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      logActivity({
        adminEmail: email || 'unknown',
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'auth',
        details: `Failed sign-in attempt for ${email}`,
        ipAddress: getClientIp(req),
      });
      res.status(401).json({ error: 'Invalid email address or password.' });
      return;
    }

    db.prepare(`UPDATE admins SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.id);

    const admin: AdminUser = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      designation: row.designation,
      phone: row.phone,
      last_login_at: new Date().toISOString(),
      created_at: row.created_at,
    };

    logActivity({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'AUTH_LOGIN',
      entityType: 'auth',
      entityId: admin.id,
      details: `Administrator ${admin.name} signed in.`,
      ipAddress: getClientIp(req),
    });

    res.json({ token: signToken(admin), admin });
  });

  router.post('/auth/forgot-password', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      res.status(400).json({ error: 'Email address is required.' });
      return;
    }

    const admin = db.prepare('SELECT id, name, email FROM admins WHERE email = ?').get(email) as
      | { id: number; name: string; email: string }
      | undefined;

    if (!admin) {
      // Do not leak user existence
      res.json({
        message: 'If an administrator account matches that email, a password reset token has been generated.',
      });
      return;
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (admin_id, token, expires_at) VALUES (?, ?, ?)').run(
      admin.id,
      token,
      expiresAt
    );

    logActivity({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'AUTH_RESET_REQUESTED',
      entityType: 'auth',
      entityId: admin.id,
      details: `Password reset requested for ${admin.email}`,
      ipAddress: getClientIp(req),
    });

    const appUrl = process.env.APP_URL && !process.env.APP_URL.includes('MY_APP_URL') ? process.env.APP_URL : `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${appUrl}/?resetToken=${token}`;

    // If an email provider is configured, send the reset link via email
    let emailed = false;
    if (isProviderConfigured()) {
      const result = await sendTransactionalOfferEmail({
        toEmail: admin.email,
        toName: admin.name,
        ccEmails: [],
        subject: 'Kalvi40 Admin Password Reset',
        bodyText: `Hello ${admin.name},\n\nA password reset was requested for your Kalvi40 administrator account.\n\nUse this link within 30 minutes to reset your password:\n${resetUrl}\n\nReset Token: ${token}\n\nIf you did not request this, ignore this message.`,
        attachmentFilename: 'reset_notice.txt',
        attachmentBuffer: Buffer.from(`Reset link: ${resetUrl}`),
      });
      emailed = result.success;
    }

    res.json({
      message: emailed
        ? 'Password reset instructions have been emailed to your administrator address.'
        : 'Email provider is not yet configured; use the secure one-time reset token below to complete your reset.',
      emailed,
      ...(emailed ? {} : { resetToken: token }),
    });
  });

  router.post('/auth/reset-password', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!token || newPassword.length < 8) {
      res.status(400).json({ error: 'Valid reset token and a new password (minimum 8 characters) are required.' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM password_resets WHERE token = ? AND used_at IS NULL')
      .get(token) as { id: number; admin_id: number; expires_at: string } | undefined;

    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      res.status(400).json({ error: 'Reset token is invalid or has expired.' });
      return;
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE admins SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(hash, row.admin_id);
    db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`).run(row.id);

    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(row.admin_id) as (AdminUser & { password_hash: string }) | undefined;
    const syncResult = admin
      ? await syncAdminToSupabase({ ...admin, currentEmail: admin.email })
      : { ok: false, error: 'Administrator record could not be reloaded.' };
    if (!syncResult.ok) {
      res.status(503).json({ error: `Password was reset locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }
    logActivity({
      adminId: row.admin_id,
      adminEmail: admin?.email || 'unknown',
      action: 'AUTH_PASSWORD_RESET',
      entityType: 'auth',
      entityId: row.admin_id,
      details: 'Administrator password reset completed.',
      ipAddress: getClientIp(req),
    });

    res.json({ message: 'Password updated successfully. You may now sign in.' });
  });

  // =========================================================================
  // PROTECTED ROUTES
  // =========================================================================
  router.use(requireAuth);

  router.get('/auth/me', (req: AuthRequest, res) => {
    res.json({ admin: req.admin });
  });

  router.put('/auth/profile', async (req: AuthRequest, res) => {
    const admin = req.admin!;
    const name = String(req.body?.name || '').trim();
    const designation = String(req.body?.designation || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!name || !email) {
      res.status(400).json({ error: 'Name and email are required.' });
      return;
    }

    const conflict = db.prepare('SELECT id FROM admins WHERE email = ? AND id != ?').get(email, admin.id);
    if (conflict) {
      res.status(409).json({ error: 'Another administrator already uses this email.' });
      return;
    }

    db.prepare(`
      UPDATE admins
      SET name = ?, designation = ?, phone = ?, email = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, designation, phone, email, admin.id);

    const updated = db
      .prepare('SELECT * FROM admins WHERE id = ?')
      .get(admin.id) as (AdminUser & { password_hash: string }) | undefined;
    if (!updated) {
      res.status(500).json({ error: 'Updated administrator record could not be reloaded.' });
      return;
    }

    const syncResult = await syncAdminToSupabase({ ...updated, currentEmail: admin.email });
    if (!syncResult.ok) {
      res.status(503).json({ error: `Profile was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: admin.id,
      adminEmail: updated.email,
      action: 'PROFILE_UPDATED',
      entityType: 'admin',
      entityId: admin.id,
      details: `Updated administrator profile (${updated.name})`,
      ipAddress: getClientIp(req),
    });

    const publicAdmin: AdminUser = {
      id: updated!.id,
      name: updated!.name,
      email: updated!.email,
      role: updated!.role,
      designation: updated!.designation,
      phone: updated!.phone,
      last_login_at: updated!.last_login_at,
      created_at: updated!.created_at,
    };
    res.json({ admin: publicAdmin });
  });

  router.put('/auth/password', async (req: AuthRequest, res) => {
    const admin = req.admin!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!currentPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' });
      return;
    }

    const row = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(admin.id) as { password_hash: string };
    if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE admins SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(newHash, admin.id);

    const updated = db.prepare('SELECT * FROM admins WHERE id = ?').get(admin.id) as unknown as AdminUser & { password_hash: string };
    const syncResult = await syncAdminToSupabase({ ...updated, currentEmail: admin.email });
    if (!syncResult.ok) {
      res.status(503).json({ error: `Password was changed locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'PASSWORD_CHANGED',
      entityType: 'admin',
      entityId: admin.id,
      details: 'Administrator password updated.',
      ipAddress: getClientIp(req),
    });

    res.json({ message: 'Password updated successfully.' });
  });

  // =========================================================================
  // DASHBOARD & ANALYTICS
  // =========================================================================
  router.get('/dashboard', (_req, res) => {
    const totalCandidates = (db.prepare('SELECT COUNT(*) as cnt FROM candidates').get() as { cnt: number }).cnt;
    const totalOffersGenerated = (db.prepare('SELECT COUNT(*) as cnt FROM candidates WHERE offer_generated = 1').get() as { cnt: number }).cnt;
    const emailsSent = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status = 'sent'`).get() as { cnt: number }).cnt;
    const emailsPending = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status IN ('pending', 'processing')`).get() as { cnt: number }).cnt;
    const emailsFailed = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status = 'failed'`).get() as { cnt: number }).cnt;

    const districtDistribution = db
      .prepare(`
        SELECT district, COUNT(*) as count, SUM(offer_generated) as offers_generated
        FROM candidates
        GROUP BY district
        ORDER BY count DESC
        LIMIT 12
      `)
      .all();

    const monthlyActivity = db
      .prepare(`
        SELECT
          strftime('%Y-%m', created_at) as month,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) as pending
        FROM send_history
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month ASC
        LIMIT 12
      `)
      .all();

    const recentActivities = db
      .prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 10')
      .all();

    const recentCampaigns = db
      .prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 6')
      .all();

    res.json({
      kpis: {
        totalCandidates,
        totalOffersGenerated,
        emailsSent,
        emailsPending,
        emailsFailed,
      },
      districtDistribution,
      monthlyActivity,
      recentActivities,
      recentCampaigns,
      providerConfigured: isProviderConfigured(),
    });
  });

  router.get('/reports', (_req, res) => {
    const totalCandidates = (db.prepare('SELECT COUNT(*) as cnt FROM candidates').get() as { cnt: number }).cnt;
    const totalOffers = (db.prepare('SELECT COUNT(*) as cnt FROM candidates WHERE offer_generated = 1').get() as { cnt: number }).cnt;
    const sentEmails = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status = 'sent'`).get() as { cnt: number }).cnt;
    const failedEmails = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status = 'failed'`).get() as { cnt: number }).cnt;
    const pendingEmails = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history WHERE status IN ('pending', 'processing')`).get() as { cnt: number }).cnt;
    const attemptedTotal = sentEmails + failedEmails;
    const successRate = attemptedTotal > 0 ? Number(((sentEmails / attemptedTotal) * 100).toFixed(1)) : 0;

    const districtReports = db
      .prepare(`
        SELECT
          c.district,
          COUNT(DISTINCT c.id) as candidates,
          SUM(CASE WHEN c.offer_generated = 1 THEN 1 ELSE 0 END) as offers_generated,
          COUNT(DISTINCT CASE WHEN sh.status = 'sent' THEN c.id END) as emails_sent,
          COUNT(DISTINCT CASE WHEN sh.status = 'failed' THEN c.id END) as emails_failed
        FROM candidates c
        LEFT JOIN send_history sh ON sh.candidate_id = c.id
        GROUP BY c.district
        ORDER BY candidates DESC
      `)
      .all();

    const schoolReports = db
      .prepare(`
        SELECT
          c.school_name,
          c.location,
          c.district,
          COUNT(DISTINCT c.id) as candidates,
          SUM(CASE WHEN c.offer_generated = 1 THEN 1 ELSE 0 END) as offers_generated,
          COUNT(DISTINCT CASE WHEN sh.status = 'sent' THEN c.id END) as emails_sent
        FROM candidates c
        LEFT JOIN send_history sh ON sh.candidate_id = c.id
        GROUP BY c.school_name, c.location, c.district
        ORDER BY candidates DESC, c.school_name ASC
      `)
      .all();

    const monthlyTrends = db
      .prepare(`
        SELECT
          strftime('%Y-%m', created_at) as month,
          COUNT(*) as candidates_added,
          SUM(offer_generated) as offers_generated
        FROM candidates
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month ASC
      `)
      .all();

    const campaignPerformance = db
      .prepare(`
        SELECT id, batch_code, name, total_count, sent_count, failed_count, pending_count, status, created_at, completed_at
        FROM campaigns
        ORDER BY id DESC
        LIMIT 25
      `)
      .all();

    res.json({
      summary: {
        totalCandidates,
        totalOffers,
        sentEmails,
        failedEmails,
        pendingEmails,
        successRate,
      },
      districtReports,
      schoolReports,
      monthlyTrends,
      campaignPerformance,
    });
  });

  router.get('/reports/export', (_req, res) => {
    const wb = XLSX.utils.book_new();

    const candidates = db
      .prepare(`
        SELECT
          c.id as ID,
          c.candidate_name as "Candidate Name",
          c.school_name as "School Name",
          c.location as Location,
          c.district as District,
          c.phone as "Phone Number",
          c.email as Email,
          c.joining_date as "Joining Date",
          CASE WHEN c.offer_generated = 1 THEN 'Generated' ELSE 'Not Generated' END as "PDF Status",
          c.offer_filename as "PDF Filename",
          c.verification_status as "Verification Status"
        FROM candidates c
        ORDER BY c.id DESC
      `)
      .all();

    const districtRows = db
      .prepare(`
        SELECT
          c.district as District,
          COUNT(DISTINCT c.id) as "Total Candidates",
          SUM(CASE WHEN c.offer_generated = 1 THEN 1 ELSE 0 END) as "Offers Generated",
          COUNT(DISTINCT CASE WHEN sh.status = 'sent' THEN c.id END) as "Emails Sent"
        FROM candidates c
        LEFT JOIN send_history sh ON sh.candidate_id = c.id
        GROUP BY c.district
        ORDER BY "Total Candidates" DESC
      `)
      .all();

    const historyRows = db
      .prepare(`
        SELECT
          batch_code as "Batch ID",
          candidate_name as "Candidate Name",
          candidate_email as Email,
          cc_emails as CC,
          pdf_filename as "PDF Filename",
          status as Status,
          delivery_status as "Delivery State",
          provider as Provider,
          sent_at as "Sent At",
          error_message as "Error Details"
        FROM send_history
        ORDER BY id DESC
      `)
      .all();

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(candidates.length ? candidates : [{ Notice: 'No candidate records' }]), 'Candidates');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(districtRows.length ? districtRows : [{ Notice: 'No district records' }]), 'District Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historyRows.length ? historyRows : [{ Notice: 'No sending records' }]), 'Sending History');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Kalvi40_Analytics_Report.xlsx"');
    res.send(buffer);
  });

  // =========================================================================
  // CANDIDATE MANAGEMENT (CRUD + SEARCH + FILTER + PAGINATION + BULK IMPORT)
  // =========================================================================
  router.get('/candidates', (req, res) => {
    const search = String(req.query.search || '').trim();
    const district = String(req.query.district || '').trim();
    const offerStatus = String(req.query.offerStatus || '').trim();
    const sortBy = String(req.query.sortBy || 'id');
    const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const all = req.query.all === 'true';
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize || 15)));

    const allowedSortCols: Record<string, string> = {
      id: 'c.id',
      candidate_name: 'c.candidate_name',
      school_name: 'c.school_name',
      district: 'c.district',
      joining_date: 'c.joining_date',
      created_at: 'c.created_at',
    };
    const orderCol = allowedSortCols[sortBy] || 'c.id';

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      whereClauses.push('(c.candidate_name LIKE ? OR c.school_name LIKE ? OR c.location LIKE ? OR c.district LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like);
    }
    if (district && district !== 'all') {
      whereClauses.push('c.district = ?');
      params.push(district);
    }
    if (offerStatus === 'generated') {
      whereClauses.push('c.offer_generated = 1');
    } else if (offerStatus === 'pending') {
      whereClauses.push('c.offer_generated = 0');
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM candidates c ${whereSql}`).get(...params) as { cnt: number };

    const limitSql = all ? '' : 'LIMIT ? OFFSET ?';
    const queryParams = all ? params : [...params, pageSize, (page - 1) * pageSize];

    const items = db
      .prepare(`
        SELECT c.*,
          (SELECT status FROM send_history sh WHERE sh.candidate_id = c.id ORDER BY sh.id DESC LIMIT 1) as last_send_status
        FROM candidates c
        ${whereSql}
        ORDER BY ${orderCol} ${sortDir}
        ${limitSql}
      `)
      .all(...queryParams);

    const districts = db
      .prepare('SELECT DISTINCT district FROM candidates ORDER BY district ASC')
      .all()
      .map((r) => (r as { district: string }).district);

    res.json({
      items,
      total: totalRow.cnt,
      page,
      pageSize,
      districts,
    });
  });

  router.get('/candidates/:id', (req, res) => {
    const id = Number(req.params.id);
    const candidate = db
      .prepare(`
        SELECT c.*,
          (SELECT status FROM send_history sh WHERE sh.candidate_id = c.id ORDER BY sh.id DESC LIMIT 1) as last_send_status
        FROM candidates c WHERE c.id = ?
      `)
      .get(id) as Candidate | undefined;

    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }
    res.json({ candidate });
  });

  router.post('/candidates', async (req: AuthRequest, res) => {
    const candidate_name = String(req.body?.candidate_name || '').trim();
    const school_name = normalizeSchoolName(String(req.body?.school_name || ''));
    const location = String(req.body?.location || '').trim();
    const district = String(req.body?.district || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const joining_date = formatDateDDMMYYYY(String(req.body?.joining_date || '').trim());
    const custom_offer_body =
      typeof req.body?.custom_offer_body === 'string' && req.body.custom_offer_body.trim()
        ? req.body.custom_offer_body.trim()
        : null;

    if (!candidate_name || !school_name || !location || !district || !phone || !email || !joining_date) {
      res.status(400).json({ error: 'All 7 candidate fields are required.' });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please provide a valid candidate email address.' });
      return;
    }

    const existing = db.prepare('SELECT id, candidate_name FROM candidates WHERE LOWER(email) = ?').get(email) as
      | { id: number; candidate_name: string }
      | undefined;

    if (existing) {
      res.status(409).json({
        error: `Duplicate email detected: "${email}" is already assigned to ${existing.candidate_name}.`,
      });
      return;
    }

    const info = db
      .prepare(`
        INSERT INTO candidates (candidate_name, school_name, location, district, phone, email, joining_date, custom_offer_body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(candidate_name, school_name, location, district, phone, email, joining_date, custom_offer_body);

    const created = db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid) as unknown as Candidate;

    const syncResult = await syncCandidateToSupabase(created);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Candidate was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CANDIDATE_CREATED',
      entityType: 'candidate',
      entityId: created.id,
      details: `Added candidate ${created.candidate_name} (${created.email}) for ${created.school_name}, ${created.district}`,
      ipAddress: getClientIp(req),
    });

    res.status(201).json({ candidate: created });
  });

  router.put('/candidates/:id', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const candidate_name = String(req.body?.candidate_name || '').trim();
    const school_name = normalizeSchoolName(String(req.body?.school_name || ''));
    const location = String(req.body?.location || '').trim();
    const district = String(req.body?.district || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const joining_date = formatDateDDMMYYYY(String(req.body?.joining_date || '').trim());
    const hasCustomBodyField = Object.prototype.hasOwnProperty.call(req.body || {}, 'custom_offer_body');
    const custom_offer_body = hasCustomBodyField
      ? typeof req.body?.custom_offer_body === 'string' && req.body.custom_offer_body.trim()
        ? req.body.custom_offer_body.trim()
        : null
      : existing.custom_offer_body ?? null;

    if (!candidate_name || !school_name || !location || !district || !email || !joining_date) {
      res.status(400).json({ error: 'All 6 candidate fields are required.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email address format.' });
      return;
    }

    const duplicate = db.prepare('SELECT id, candidate_name FROM candidates WHERE LOWER(email) = ? AND id != ?').get(email, id) as
      | { id: number; candidate_name: string }
      | undefined;
    if (duplicate) {
      res.status(409).json({ error: `Duplicate email detected: "${email}" belongs to ${duplicate.candidate_name}.` });
      return;
    }

    db.prepare(`
      UPDATE candidates
      SET candidate_name = ?,
          school_name = ?,
          location = ?,
          district = ?,
          phone = ?,
          email = ?,
          joining_date = ?,
          custom_offer_body = ?,
          offer_generated = 0,
          verification_status = 'unverified',
          verification_issues = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(candidate_name, school_name, location, district, phone, email, joining_date, custom_offer_body, id);

    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as unknown as Candidate;

    const syncResult = await syncCandidateToSupabase(updated, existing.email);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Candidate was updated locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CANDIDATE_UPDATED',
      entityType: 'candidate',
      entityId: id,
      details: `Updated candidate ${updated.candidate_name} (${updated.email}); PDF regeneration queued on next preview/send.`,
      ipAddress: getClientIp(req),
    });

    res.json({ candidate: updated });
  });

  router.put('/candidates/:id/offer-content', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const rawBody = typeof req.body?.custom_offer_body === 'string' ? req.body.custom_offer_body.trim() : '';
    const customOfferBody = rawBody ? rawBody : null;

    db.prepare(`
      UPDATE candidates
      SET custom_offer_body = ?,
          offer_generated = 0,
          verification_status = 'unverified',
          verification_issues = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(customOfferBody, id);

    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as unknown as Candidate;
    const pdf = await generateOfferLetterPdf(updated);
    const refreshed = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as unknown as Candidate;

    const syncResult = await syncCandidateToSupabase(refreshed);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Offer content was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CANDIDATE_OFFER_CONTENT_UPDATED',
      entityType: 'candidate',
      entityId: id,
      details: customOfferBody
        ? `Saved custom offer letter content and regenerated ${pdf.filename} for ${updated.candidate_name}.`
        : `Cleared custom offer override (reverted to master template) and regenerated ${pdf.filename} for ${updated.candidate_name}.`,
      ipAddress: getClientIp(req),
    });

    res.json({
      candidate: refreshed,
      filename: pdf.filename,
    });
  });

  router.delete('/candidates/:id', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const syncResult = await deleteCandidatesFromSupabase([existing.email]);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Candidate was not deleted because Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    db.prepare('DELETE FROM candidates WHERE id = ?').run(id);

    if (existing.offer_filename) {
      const pdfPath = path.join(pdfStorageDir, existing.offer_filename);
      if (fs.existsSync(pdfPath)) {
        try {
          fs.unlinkSync(pdfPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CANDIDATE_DELETED',
      entityType: 'candidate',
      entityId: id,
      details: `Deleted candidate ${existing.candidate_name} (${existing.email})`,
      ipAddress: getClientIp(req),
    });

    res.json({ message: 'Candidate deleted.' });
  });

  router.post('/candidates/bulk-delete', async (req: AuthRequest, res) => {
    const deleteAll = Boolean(req.body?.deleteAll);
    const candidateIds = Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.map(Number).filter(Boolean) : [];

    if (!deleteAll && candidateIds.length === 0) {
      res.status(400).json({ error: 'Select candidates to delete or specify deleteAll.' });
      return;
    }

    const targets = (
      deleteAll
        ? db.prepare('SELECT id, candidate_name, email, offer_filename FROM candidates').all()
        : db.prepare(`SELECT id, candidate_name, email, offer_filename FROM candidates WHERE id IN (${candidateIds.map(() => '?').join(',')})`).all(...candidateIds)
      ) as Array<{ id: number; candidate_name: string; email: string; offer_filename: string | null }>;

    if (targets.length === 0) {
      res.json({ deletedCount: 0, message: 'No candidates to delete.' });
      return;
    }

    const syncResult = await deleteCandidatesFromSupabase(targets.map((target) => target.email));
    if (!syncResult.ok) {
      res.status(503).json({ error: `Candidates were not deleted because Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    if (deleteAll) {
      db.prepare('DELETE FROM candidates').run();
    } else {
      db.prepare(`DELETE FROM candidates WHERE id IN (${targets.map(() => '?').join(',')})`).run(...targets.map((t) => t.id));
    }

    for (const t of targets) {
      const filenames = [t.offer_filename, sanitizeOfferFilename(t.candidate_name)].filter(Boolean) as string[];
      for (const fname of filenames) {
        const pdfPath = path.join(pdfStorageDir, fname);
        if (fs.existsSync(pdfPath)) {
          try {
            fs.unlinkSync(pdfPath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: deleteAll ? 'CANDIDATES_CLEARED' : 'CANDIDATES_BULK_DELETED',
      entityType: 'candidate',
      details: `Removed ${targets.length} candidate record(s)${deleteAll ? ' (cleared directory)' : ''}.`,
      ipAddress: getClientIp(req),
    });

    res.json({ deletedCount: targets.length, message: `Removed ${targets.length} candidate(s).` });
  });

  router.post('/candidates/bulk-import', async (req: AuthRequest, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const skipDuplicates = req.body?.skipDuplicates !== false;

    if (records.length === 0) {
      res.status(400).json({ error: 'No candidate records supplied for import.' });
      return;
    }

    const insertedIds: number[] = [];
    const skipped: Array<{ email: string; reason: string }> = [];

    const checkExisting = db.prepare('SELECT id FROM candidates WHERE LOWER(email) = ?');
    const insertStmt = db.prepare(`
      INSERT INTO candidates (candidate_name, school_name, location, district, phone, email, joining_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE candidates
      SET candidate_name = ?, school_name = ?, location = ?, district = ?, phone = ?, joining_date = ?,
          offer_generated = 0, verification_status = 'unverified', updated_at = datetime('now')
      WHERE id = ?
    `);

    db.exec('BEGIN TRANSACTION');
    try {
      for (const raw of records) {
        const candidate_name = String(raw.candidate_name || '').trim();
        const school_name = normalizeSchoolName(String(raw.school_name || ''));
        const location = String(raw.location || '').trim();
        const district = String(raw.district || '').trim();
        const phone = String(raw.phone || '').trim();
        const email = String(raw.email || '').trim().toLowerCase();
        const joining_date = formatDateDDMMYYYY(String(raw.joining_date || '').trim());

        if (!candidate_name || !school_name || !location || !district || !phone || !email || !joining_date) {
          skipped.push({ email: email || '(blank)', reason: 'Missing required fields' });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          skipped.push({ email, reason: 'Invalid email format' });
          continue;
        }

        const existing = checkExisting.get(email) as { id: number } | undefined;
        if (existing) {
          if (skipDuplicates) {
            skipped.push({ email, reason: 'Duplicate email already exists in database' });
            continue;
          } else {
            updateStmt.run(candidate_name, school_name, location, district, phone, joining_date, existing.id);
            insertedIds.push(existing.id);
            continue;
          }
        }

        const info = insertStmt.run(candidate_name, school_name, location, district, phone, email, joining_date);
        insertedIds.push(Number(info.lastInsertRowid));
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Bulk import transaction failed.' });
      return;
    }

    const importedCandidates = insertedIds.map((id) =>
      db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined
    ).filter((candidate): candidate is Candidate => Boolean(candidate));
    const syncResult = await syncCandidatesToSupabase(importedCandidates);
    if (!syncResult.ok) {
      res.status(503).json({
        error: `${insertedIds.length} candidate record(s) were saved locally, but Supabase synchronization failed: ${syncResult.error}`,
        importedCount: insertedIds.length,
        skippedCount: skipped.length,
      });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'BULK_IMPORT',
      entityType: 'candidate',
      details: `Imported ${insertedIds.length} candidate(s); skipped ${skipped.length} duplicate/invalid row(s).`,
      ipAddress: getClientIp(req),
    });

    res.status(201).json({
      importedCount: insertedIds.length,
      skippedCount: skipped.length,
      skipped,
      importedIds: insertedIds,
    });
  });

  // =========================================================================
  // PDF GENERATION, PREVIEW & VERIFICATION
  // =========================================================================
  router.post('/candidates/:id/generate-pdf', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const result = await generateOfferLetterPdf(candidate);
    const updated = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as unknown as Candidate;

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'PDF_GENERATED',
      entityType: 'candidate',
      entityId: id,
      details: `Generated offer letter PDF ${result.filename} for ${candidate.candidate_name}`,
      ipAddress: getClientIp(req),
    });

    res.json({
      filename: result.filename,
      sizeBytes: result.buffer.length,
      candidate: updated,
    });
  });

  router.post('/candidates/bulk-generate-pdfs', async (req: AuthRequest, res) => {
    const candidateIds = Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.map(Number) : [];
    const targetCandidates = (
      candidateIds.length > 0
        ? db
            .prepare(`SELECT * FROM candidates WHERE id IN (${candidateIds.map(() => '?').join(',')})`)
            .all(...candidateIds)
        : db.prepare('SELECT * FROM candidates').all()
    ) as unknown as Candidate[];

    if (targetCandidates.length === 0) {
      res.status(400).json({ error: 'No candidates selected for PDF generation.' });
      return;
    }

    const generated: Array<{ id: number; name: string; filename: string }> = [];
    for (const c of targetCandidates) {
      const pdf = await generateOfferLetterPdf(c);
      generated.push({ id: c.id, name: c.candidate_name, filename: pdf.filename });
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'BULK_PDF_GENERATED',
      entityType: 'candidate',
      details: `Generated ${generated.length} personalized offer letter PDFs.`,
      ipAddress: getClientIp(req),
    });

    res.json({ generatedCount: generated.length, files: generated });
  });

  router.get('/candidates/:id/pdf', async (req, res) => {
    const id = Number(req.params.id);
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const filename = sanitizeOfferFilename(candidate.candidate_name);
    const filePath = path.join(pdfStorageDir, filename);

    let buffer: Buffer;
    if (!candidate.offer_generated || !fs.existsSync(filePath) || req.query.refresh === '1') {
      const generated = await generateOfferLetterPdf(candidate);
      buffer = generated.buffer;
    } else {
      buffer = fs.readFileSync(filePath);
    }

    const isDownload = req.query.download === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`
    );
    res.send(buffer);
  });

  router.get('/candidates/:id/verify', async (req, res) => {
    const id = Number(req.params.id);
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as Candidate | undefined;
    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    const result = await verifyCandidateForSending(candidate, { ensurePdfGenerated: true });
    res.json(result);
  });

  router.post('/candidates/verify-batch', async (req, res) => {
    const candidateIds = Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.map(Number) : [];
    if (candidateIds.length === 0) {
      res.status(400).json({ error: 'Select at least one candidate to verify.' });
      return;
    }

    const candidates = db
      .prepare(`SELECT * FROM candidates WHERE id IN (${candidateIds.map(() => '?').join(',')})`)
      .all(...candidateIds) as unknown as Candidate[];

    const templateOverride =
      req.body?.subject && req.body?.body
        ? { subject: String(req.body.subject), body: String(req.body.body) }
        : undefined;

    const results = [];
    for (const c of candidates) {
      const v = await verifyCandidateForSending(c, { ensurePdfGenerated: true, templateOverride });
      results.push({
        candidate: c,
        verification: v,
      });
    }

    const validCount = results.filter((r) => r.verification.valid).length;
    res.json({
      total: results.length,
      validCount,
      invalidCount: results.length - validCount,
      results,
    });
  });

  // =========================================================================
  // MASTER EMAIL TEMPLATE & CC MANAGEMENT
  // =========================================================================
  router.get('/templates/master', async (_req, res) => {
    const template = await getMasterTemplate();
    res.json({ template });
  });

  router.put('/templates/master', async (req: AuthRequest, res) => {
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.body || '').trim();

    if (!subject || !body) {
      res.status(400).json({ error: 'Email subject and body cannot be empty.' });
      return;
    }

    const current = await getMasterTemplate();
    db.prepare(`
      UPDATE email_templates
      SET subject = ?, body = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(subject, body, req.admin!.email, current.id);

    const updated = await getMasterTemplate();
    const syncResult = await syncMasterEmailTemplateToSupabase(updated);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Template was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'TEMPLATE_UPDATED',
      entityType: 'email_template',
      entityId: updated.id,
      details: `Updated master email template subject: "${subject}"`,
      ipAddress: getClientIp(req),
    });

    res.json({ template: updated });
  });

  router.post('/templates/master/reset', async (req: AuthRequest, res) => {
    const current = await getMasterTemplate();
    db.prepare(`
      UPDATE email_templates
      SET subject = ?, body = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(DEFAULT_MASTER_SUBJECT, DEFAULT_MASTER_BODY, req.admin!.email, current.id);

    const updated = await getMasterTemplate();
    const syncResult = await syncMasterEmailTemplateToSupabase(updated);
    if (!syncResult.ok) {
      res.status(503).json({ error: `Template was reset locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'TEMPLATE_RESET',
      entityType: 'email_template',
      entityId: updated.id,
      details: 'Reset master email template to Kalvi40 default content.',
      ipAddress: getClientIp(req),
    });

    res.json({ template: updated });
  });

  // =========================================================================
  // MASTER OFFER LETTER PDF CONTENT TEMPLATE
  // =========================================================================
  router.get('/templates/offer', (_req, res) => {
    res.json({ template: getOfferLetterTemplate() });
  });

  router.put('/templates/offer', async (req: AuthRequest, res) => {
    const body = req.body || {};
    const heading = String(body.heading ?? '').trim();
    const greeting = String(body.greeting ?? '').trim();
    const offerBody = String(body.body ?? '').trim();
    const closing = String(body.closing ?? '').trim();
    const signatoryTitle = String(body.signatory_title ?? '').trim();
    const signatoryOrg = String(body.signatory_org ?? '').trim();

    if (!heading || !offerBody) {
      res.status(400).json({ error: 'Offer letter heading and body content cannot be empty.' });
      return;
    }

    if (typeof body.header_name === 'string') setSetting('offer_header_name', body.header_name.trim());
    if (typeof body.header_role === 'string') setSetting('offer_header_role', body.header_role.trim());
    if (typeof body.brand_title === 'string' && body.brand_title.trim()) {
      setSetting('offer_brand_title', body.brand_title.trim());
    }
    if (typeof body.brand_subtitle === 'string') setSetting('offer_brand_subtitle', body.brand_subtitle.trim());
    if (typeof body.trust_regn === 'string') setSetting('trust_regn', body.trust_regn.trim());
    if (typeof body.trust_address === 'string') setSetting('trust_address', body.trust_address.trim());
    if (typeof body.trust_mobile === 'string') setSetting('trust_mobile', body.trust_mobile.trim());
    if (typeof body.trust_email === 'string') setSetting('trust_email', body.trust_email.trim());
    if (typeof body.trust_website === 'string') setSetting('trust_website', body.trust_website.trim());

    setSetting('offer_heading', heading);
    if (greeting) setSetting('offer_greeting', greeting);
    setSetting('offer_body', offerBody);
    if (closing) setSetting('offer_closing', closing);
    if (signatoryTitle) setSetting('offer_signatory_title', signatoryTitle);
    if (signatoryOrg) setSetting('offer_signatory_org', signatoryOrg);
    if (typeof body.contract_end_date === 'string' && body.contract_end_date.trim()) {
      setSetting('contract_end_date', body.contract_end_date.trim());
    }
    if (typeof body.stipend_text === 'string' && body.stipend_text.trim()) {
      setSetting('stipend_text', body.stipend_text.trim());
    }
    if (typeof body.footer_left_url === 'string') setSetting('offer_footer_left_url', body.footer_left_url.trim());
    if (typeof body.footer_right_url === 'string') setSetting('offer_footer_right_url', body.footer_right_url.trim());
    if (body.body_font_size !== undefined) {
      const parsed = Number(body.body_font_size);
      if (Number.isFinite(parsed)) {
        const clamped = Math.max(9, Math.min(12.5, Number(parsed.toFixed(1))));
        setSetting('offer_body_font_size', String(clamped));
      }
    }

    // Mark PDFs stale so next preview, download, or send uses the updated offer content
    db.prepare(`UPDATE candidates SET offer_generated = 0, verification_status = 'unverified', updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Offer template was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'OFFER_TEMPLATE_UPDATED',
      entityType: 'offer_template',
      details: `Updated master offer letter PDF template ("${heading}"). Existing PDFs queued for fresh generation.`,
      ipAddress: getClientIp(req),
    });

    res.json({ template: getOfferLetterTemplate() });
  });

  router.post('/templates/offer/preview-pdf', async (req, res) => {
    try {
      const draftTemplate = req.body?.template && typeof req.body.template === 'object' ? req.body.template : {};
      const candidateId = Number(req.body?.candidateId || 0);
      const dbCandidate = candidateId
        ? (db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as Candidate | undefined)
        : (db.prepare('SELECT * FROM candidates ORDER BY id ASC LIMIT 1').get() as Candidate | undefined);

      const sampleCandidate = dbCandidate
        ? { ...dbCandidate, custom_offer_body: null }
        : {
            candidate_name: 'E Sathiya Kaviya',
            school_name: 'Govt Panchayat Union Middle School',
            location: 'Pattiyandal',
            district: 'Tiruvannamalai',
            email: 'candidate@example.com',
            joining_date: '21.10.2026',
            custom_offer_body: null,
          };

      const { buffer, filename } = await buildOfferLetterPdfBuffer(sampleCandidate, draftTemplate);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to generate preview PDF.' });
    }
  });

  router.post('/templates/offer/reset', async (req: AuthRequest, res) => {
    setSetting('offer_header_name', DEFAULT_OFFER_LETTER_TEMPLATE.header_name);
    setSetting('offer_header_role', DEFAULT_OFFER_LETTER_TEMPLATE.header_role);
    setSetting('offer_brand_title', DEFAULT_OFFER_LETTER_TEMPLATE.brand_title);
    setSetting('offer_brand_subtitle', DEFAULT_OFFER_LETTER_TEMPLATE.brand_subtitle);
    setSetting('trust_regn', DEFAULT_OFFER_LETTER_TEMPLATE.trust_regn);
    setSetting('trust_address', DEFAULT_OFFER_LETTER_TEMPLATE.trust_address);
    setSetting('trust_mobile', DEFAULT_OFFER_LETTER_TEMPLATE.trust_mobile);
    setSetting('trust_email', DEFAULT_OFFER_LETTER_TEMPLATE.trust_email);
    setSetting('trust_website', DEFAULT_OFFER_LETTER_TEMPLATE.trust_website);
    setSetting('offer_heading', DEFAULT_OFFER_LETTER_TEMPLATE.heading);
    setSetting('offer_greeting', DEFAULT_OFFER_LETTER_TEMPLATE.greeting);
    setSetting('offer_body', DEFAULT_OFFER_LETTER_TEMPLATE.body);
    setSetting('offer_closing', DEFAULT_OFFER_LETTER_TEMPLATE.closing);
    setSetting('offer_signatory_title', DEFAULT_OFFER_LETTER_TEMPLATE.signatory_title);
    setSetting('offer_signatory_org', DEFAULT_OFFER_LETTER_TEMPLATE.signatory_org);
    setSetting('contract_end_date', DEFAULT_OFFER_LETTER_TEMPLATE.contract_end_date);
    setSetting('stipend_text', DEFAULT_OFFER_LETTER_TEMPLATE.stipend_text);
    setSetting('offer_footer_left_url', DEFAULT_OFFER_LETTER_TEMPLATE.footer_left_url);
    setSetting('offer_footer_right_url', DEFAULT_OFFER_LETTER_TEMPLATE.footer_right_url);
    setSetting('offer_body_font_size', String(DEFAULT_OFFER_LETTER_TEMPLATE.body_font_size));

    db.prepare(`UPDATE candidates SET offer_generated = 0, verification_status = 'unverified', updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Offer template reset locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'OFFER_TEMPLATE_RESET',
      entityType: 'offer_template',
      details: 'Reset master offer letter PDF template to original BumbleB Trust default.',
      ipAddress: getClientIp(req),
    });

    res.json({ template: getOfferLetterTemplate() });
  });

  router.get('/cc', (_req, res) => {
    const items = db.prepare('SELECT * FROM cc_recipients ORDER BY id ASC').all() as unknown as CcRecipient[];
    res.json({ items });
  });

  router.post('/cc', async (req: AuthRequest, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const label = String(req.body?.label || '').trim();
    const isDefault = req.body?.is_default === false ? 0 : 1;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please provide a valid CC email address.' });
      return;
    }

    const existing = db.prepare('SELECT id FROM cc_recipients WHERE LOWER(email) = ?').get(email);
    if (existing) {
      res.status(409).json({ error: `"${email}" is already in the CC list.` });
      return;
    }

    const info = db
      .prepare('INSERT INTO cc_recipients (email, label, enabled, is_default) VALUES (?, ?, 1, ?)')
      .run(email, label, isDefault);
    const created = db.prepare('SELECT * FROM cc_recipients WHERE id = ?').get(info.lastInsertRowid) as unknown as CcRecipient;
    const syncResult = await syncCcRecipientToSupabase(created);
    if (!syncResult.ok) {
      res.status(503).json({ error: `CC recipient was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CC_ADDED',
      entityType: 'cc_recipient',
      entityId: created.id,
      details: `Added CC recipient ${created.email} (${created.label || 'No label'})`,
      ipAddress: getClientIp(req),
    });

    res.status(201).json({ item: created });
  });

  router.put('/cc/:id', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM cc_recipients WHERE id = ?').get(id) as CcRecipient | undefined;
    if (!existing) {
      res.status(404).json({ error: 'CC recipient not found.' });
      return;
    }

    const email = req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() : existing.email;
    const label = req.body?.label !== undefined ? String(req.body.label).trim() : existing.label;
    const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
    const is_default = req.body?.is_default !== undefined ? (req.body.is_default ? 1 : 0) : existing.is_default;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid CC email address.' });
      return;
    }

    db.prepare('UPDATE cc_recipients SET email = ?, label = ?, enabled = ?, is_default = ? WHERE id = ?').run(
      email,
      label,
      enabled,
      is_default,
      id
    );

    const updated = db.prepare('SELECT * FROM cc_recipients WHERE id = ?').get(id) as unknown as CcRecipient;
    const syncResult = await syncCcRecipientToSupabase({ ...updated, previousEmail: existing.email });
    if (!syncResult.ok) {
      res.status(503).json({ error: `CC recipient was updated locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CC_UPDATED',
      entityType: 'cc_recipient',
      entityId: id,
      details: `Updated CC recipient ${updated.email} (enabled: ${Boolean(updated.enabled)})`,
      ipAddress: getClientIp(req),
    });

    res.json({ item: updated });
  });

  router.delete('/cc/:id', async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM cc_recipients WHERE id = ?').get(id) as CcRecipient | undefined;
    if (!existing) {
      res.status(404).json({ error: 'CC recipient not found.' });
      return;
    }

    const syncResult = await deleteCcRecipientFromSupabase(existing.email);
    if (!syncResult.ok) {
      res.status(503).json({ error: `CC recipient was not deleted because Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    db.prepare('DELETE FROM cc_recipients WHERE id = ?').run(id);

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CC_DELETED',
      entityType: 'cc_recipient',
      entityId: id,
      details: `Removed CC recipient ${existing.email}`,
      ipAddress: getClientIp(req),
    });

    res.json({ message: 'CC recipient removed.' });
  });

  // =========================================================================
  // INDIVIDUAL SEND & BULK CAMPAIGNS
  // =========================================================================
  router.post('/send/individual', async (req: AuthRequest, res) => {
    const candidateId = Number(req.body?.candidateId);
    const customCc = Array.isArray(req.body?.ccEmails) ? req.body.ccEmails.map(String) : null;
    const allowResend = Boolean(req.body?.allowResend);

    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as Candidate | undefined;
    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }

    if (!isProviderConfigured()) {
      res.status(400).json({
        error: 'SMTP credentials are not configured. Configure your SMTP settings in Email Configuration before sending.',
      });
      return;
    }

    if (!allowResend) {
      const alreadySent = db
        .prepare(`SELECT id, batch_code, sent_at FROM send_history WHERE candidate_id = ? AND status = 'sent' LIMIT 1`)
        .get(candidateId) as { id: number; batch_code: string; sent_at: string } | undefined;
      if (alreadySent) {
        res.status(409).json({
          error: `An offer email was already sent to ${candidate.email} in ${alreadySent.batch_code}. Confirm "Allow Resend" if you intend to send a duplicate.`,
        });
        return;
      }
    }

    const verification = await verifyCandidateForSending(candidate, { ensurePdfGenerated: true });
    if (!verification.valid) {
      res.status(422).json({
        error: `Verification failed: ${verification.issues.join(' | ')}`,
        verification,
      });
      return;
    }

    const ccList =
      customCc ??
      (db.prepare('SELECT email FROM cc_recipients WHERE enabled = 1 AND is_default = 1').all() as Array<{ email: string }>).map(
        (r) => r.email
      );

    const pdfPath = path.join(pdfStorageDir, verification.pdfFilename);
    const pdfBuffer = fs.readFileSync(pdfPath);
    const batchCode = `IND-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

    const result = await sendTransactionalOfferEmail({
      toEmail: candidate.email,
      toName: candidate.candidate_name,
      ccEmails: ccList,
      subject: verification.renderedSubject,
      bodyText: verification.renderedBody,
      attachmentFilename: verification.pdfFilename,
      attachmentBuffer: pdfBuffer,
    });

    const insertHistory = db.prepare(`
      INSERT INTO send_history (
        campaign_id, batch_code, candidate_id, candidate_name, candidate_email,
        cc_emails, pdf_filename, subject, body_rendered, status, provider,
        provider_message_id, delivery_status, error_message, attempts, sent_at
      )
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    const info = insertHistory.run(
      batchCode,
      candidate.id,
      candidate.candidate_name,
      candidate.email,
      ccList.join(', '),
      verification.pdfFilename,
      verification.renderedSubject,
      verification.renderedBody,
      result.success ? 'sent' : 'failed',
      result.provider,
      result.messageId,
      result.deliveryStatus,
      result.errorMessage,
      result.success ? new Date().toISOString() : null
    );

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: result.success ? 'INDIVIDUAL_EMAIL_SENT' : 'INDIVIDUAL_EMAIL_FAILED',
      entityType: 'send_history',
      entityId: Number(info.lastInsertRowid),
      details: result.success
        ? `Sent individual offer (${verification.pdfFilename}) to ${candidate.email} via ${result.provider}`
        : `Failed individual offer to ${candidate.email}: ${result.errorMessage}`,
      ipAddress: getClientIp(req),
    });

    if (!result.success) {
      res.status(502).json({ error: result.errorMessage || 'Email delivery failed.', historyId: info.lastInsertRowid });
      return;
    }

    res.json({
      message: `Offer email accepted by ${result.provider} for ${candidate.email}.`,
      batchCode,
      messageId: result.messageId,
      historyId: info.lastInsertRowid,
    });
  });

  router.get('/campaigns', (_req, res) => {
    const items = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all() as unknown as Campaign[];
    res.json({ items });
  });

  router.get('/campaigns/:id', (req, res) => {
    const id = Number(req.params.id);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }
    const deliveries = db.prepare('SELECT * FROM send_history WHERE campaign_id = ? ORDER BY id ASC').all(id);
    res.json({ campaign, deliveries });
  });

  router.post('/campaigns', async (req: AuthRequest, res) => {
    const name = String(req.body?.name || '').trim() || `Kalvi40 Offer Batch ${new Date().toLocaleDateString('en-IN')}`;
    const candidateIds: number[] = Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.map(Number) : [];
    const ccEmails: string[] = Array.isArray(req.body?.ccEmails) ? req.body.ccEmails.map((e: unknown) => String(e).trim()).filter(Boolean) : [];
    const skipAlreadySent = req.body?.skipAlreadySent !== false;

    if (candidateIds.length === 0) {
      res.status(400).json({ error: 'Select at least one candidate to create a campaign.' });
      return;
    }

    if (!isProviderConfigured()) {
      res.status(400).json({
        error: 'SMTP credentials are not configured. Configure your SMTP settings in Email Configuration before launching a bulk campaign.',
      });
      return;
    }

    const master = await getMasterTemplate();
    const subject = String(req.body?.subject || master.subject).trim();
    const body = String(req.body?.body || master.body).trim();

    const candidates = db
      .prepare(`SELECT * FROM candidates WHERE id IN (${candidateIds.map(() => '?').join(',')})`)
      .all(...candidateIds) as unknown as Candidate[];

    if (candidates.length === 0) {
      res.status(404).json({ error: 'No matching candidates found.' });
      return;
    }

    // Duplicate prevention & verification
    const validCandidates: Array<{ candidate: Candidate; renderedSubject: string; renderedBody: string; pdfFilename: string }> = [];
    const blockedCandidates: Array<{ id: number; name: string; email: string; reason: string }> = [];

    for (const c of candidates) {
      if (skipAlreadySent) {
        const already = db
          .prepare(`SELECT batch_code FROM send_history WHERE candidate_id = ? AND status IN ('sent', 'pending', 'processing') LIMIT 1`)
          .get(c.id) as { batch_code: string } | undefined;
        if (already) {
          blockedCandidates.push({
            id: c.id,
            name: c.candidate_name,
            email: c.email,
            reason: `Already sent or queued in ${already.batch_code} (duplicate prevented).`,
          });
          continue;
        }
      }

      const v = await verifyCandidateForSending(c, {
        ensurePdfGenerated: true,
        templateOverride: { subject, body },
      });

      if (!v.valid) {
        blockedCandidates.push({
          id: c.id,
          name: c.candidate_name,
          email: c.email,
          reason: v.issues.join(' | '),
        });
      } else {
        validCandidates.push({
          candidate: c,
          renderedSubject: v.renderedSubject,
          renderedBody: v.renderedBody,
          pdfFilename: v.pdfFilename,
        });
      }
    }

    if (validCandidates.length === 0) {
      const duplicateBlocked = blockedCandidates.filter((b) => b.reason.includes('Already sent or queued'));
      const summaryError =
        duplicateBlocked.length === blockedCandidates.length && duplicateBlocked.length > 0
          ? `All ${duplicateBlocked.length} selected candidate(s) were already sent (${duplicateBlocked
              .slice(0, 2)
              .map((b) => b.name)
              .join(', ')}${duplicateBlocked.length > 2 ? ', ...' : ''}). Uncheck "Prevent duplicate sending" to resend, or select unsent candidates.`
          : blockedCandidates[0]?.reason || 'No valid eligible candidates to send in this batch.';
      res.status(422).json({
        error: summaryError,
        blockedCandidates,
      });
      return;
    }

    const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const seq = ((db.prepare('SELECT COUNT(*) as cnt FROM campaigns').get() as { cnt: number }).cnt + 1)
      .toString()
      .padStart(3, '0');
    const batchCode = `BATCH-${dateTag}-${seq}`;

    let campaignId = 0;
    db.exec('BEGIN TRANSACTION');
    try {
      const campInfo = db
        .prepare(`
          INSERT INTO campaigns (
            batch_code, name, subject, body, cc_emails_json,
            total_count, valid_count, sent_count, failed_count, pending_count,
            status, created_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'queued', ?)
        `)
        .run(
          batchCode,
          name,
          subject,
          body,
          JSON.stringify(ccEmails),
          candidates.length,
          validCandidates.length,
          validCandidates.length,
          req.admin!.email
        );

      campaignId = Number(campInfo.lastInsertRowid);

      const insertJob = db.prepare(`
        INSERT INTO send_history (
          campaign_id, batch_code, candidate_id, candidate_name, candidate_email,
          cc_emails, pdf_filename, subject, body_rendered, status, provider, delivery_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'not_sent')
      `);

      const activeProvider = 'smtp';
      for (const item of validCandidates) {
        insertJob.run(
          campaignId,
          batchCode,
          item.candidate.id,
          item.candidate.candidate_name,
          item.candidate.email,
          ccEmails.join(', '),
          item.pdfFilename,
          item.renderedSubject,
          item.renderedBody,
          activeProvider
        );
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to queue campaign.' });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'CAMPAIGN_LAUNCHED',
      entityType: 'campaign',
      entityId: campaignId,
      details: `Queued bulk campaign ${batchCode} ("${name}") with ${validCandidates.length} individual offer emails (${blockedCandidates.length} excluded/blocked).`,
      ipAddress: getClientIp(req),
    });

    // Background execution continues even if the browser closes
    triggerQueueWorker();

    const createdCampaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as unknown as Campaign;
    res.status(202).json({
      campaign: createdCampaign,
      queuedCount: validCandidates.length,
      blockedCount: blockedCandidates.length,
      blockedCandidates,
    });
  });

  // =========================================================================
  // SENDING HISTORY, RETRIES & AUDIT LOGS
  // =========================================================================
  router.get('/history', (req, res) => {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const batch = String(req.query.batch || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize || 20)));

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      where.push('(candidate_name LIKE ? OR candidate_email LIKE ? OR batch_code LIKE ? OR pdf_filename LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status && status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (batch && batch !== 'all') {
      where.push('batch_code = ?');
      params.push(batch);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM send_history ${whereSql}`).get(...params) as { cnt: number }).cnt;
    const items = db
      .prepare(`SELECT * FROM send_history ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);

    const batches = db
      .prepare('SELECT DISTINCT batch_code FROM send_history ORDER BY id DESC LIMIT 50')
      .all()
      .map((r) => (r as { batch_code: string }).batch_code);

    res.json({ items, total, page, pageSize, batches });
  });

  router.post('/history/:id/retry', (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM send_history WHERE id = ?').get(id) as SendHistoryRecord | undefined;
    if (!row) {
      res.status(404).json({ error: 'History record not found.' });
      return;
    }
    if (row.status === 'sent') {
      res.status(400).json({ error: 'This email was already sent.' });
      return;
    }
    if (!isProviderConfigured()) {
      res.status(400).json({ error: 'Configure SMTP credentials before retrying.' });
      return;
    }

    db.prepare(`
      UPDATE send_history
      SET status = 'pending', error_message = NULL, delivery_status = 'not_sent', updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'EMAIL_RETRY_QUEUED',
      entityType: 'send_history',
      entityId: id,
      details: `Re-queued failed email to ${row.candidate_email} (${row.batch_code})`,
      ipAddress: getClientIp(req),
    });

    triggerQueueWorker();
    res.json({ message: 'Email re-queued for delivery.' });
  });

  router.post('/history/retry-batch', (req: AuthRequest, res) => {
    const batchCode = String(req.body?.batchCode || '').trim();
    if (!isProviderConfigured()) {
      res.status(400).json({ error: 'Configure SMTP credentials before retrying.' });
      return;
    }

    const result = batchCode
      ? db
          .prepare(`UPDATE send_history SET status = 'pending', error_message = NULL, delivery_status = 'not_sent', updated_at = datetime('now') WHERE status = 'failed' AND batch_code = ?`)
          .run(batchCode)
      : db
          .prepare(`UPDATE send_history SET status = 'pending', error_message = NULL, delivery_status = 'not_sent', updated_at = datetime('now') WHERE status = 'failed'`)
          .run();

    const count = Number(result.changes || 0);
    if (count > 0) {
      logActivity({
        adminId: req.admin!.id,
        adminEmail: req.admin!.email,
        action: 'BULK_RETRY_QUEUED',
        entityType: 'send_history',
        details: `Re-queued ${count} failed email(s)${batchCode ? ` in ${batchCode}` : ''}.`,
        ipAddress: getClientIp(req),
      });
      triggerQueueWorker();
    }

    res.json({ requeuedCount: count });
  });

  router.post('/history/sync-delivery', (_req: AuthRequest, res) => {
    res.json({ checkedCount: 0, updatedCount: 0, message: 'SMTP relay records acceptance status directly upon dispatch.' });
  });

  router.get('/history/export', (req, res) => {
    const status = String(req.query.status || '').trim();
    const where = status && status !== 'all' ? 'WHERE status = ?' : '';
    const params = status && status !== 'all' ? [status] : [];
    const rows = db
      .prepare(`
        SELECT
          batch_code as "Batch ID",
          candidate_name as "Candidate Name",
          candidate_email as "Email Address",
          cc_emails as "CC Recipients",
          pdf_filename as "PDF Filename",
          status as "Queue Status",
          delivery_status as "Provider Delivery State",
          provider as "Provider",
          provider_message_id as "Message ID",
          attempts as "Attempts",
          sent_at as "Sending Date",
          error_message as "Error Message"
        FROM send_history
        ${where}
        ORDER BY id DESC
      `)
      .all(...params);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Notice: 'No sending history available' }]), 'Sending History');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Disposition', 'attachment; filename="Kalvi40-Sending-History.xlsx"');
    res.send(buffer);
  });

  router.get('/logs', (req, res) => {
    const search = String(req.query.search || '').trim();
    const action = String(req.query.action || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize || 25)));

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (search) {
      where.push('(admin_email LIKE ? OR action LIKE ? OR details LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (action && action !== 'all') {
      where.push('action = ?');
      params.push(action);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM activity_logs ${whereSql}`).get(...params) as { cnt: number }).cnt;
    const items = db
      .prepare(`SELECT * FROM activity_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);

    const actions = db
      .prepare('SELECT DISTINCT action FROM activity_logs ORDER BY action ASC')
      .all()
      .map((r) => (r as { action: string }).action);

    res.json({ items, total, page, pageSize, actions });
  });

  // =========================================================================
  // GENERAL & EMAIL SETTINGS
  // =========================================================================
  router.get('/settings/general', (_req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    res.json({
      settings: {
        organization_name: getSetting('organization_name', 'BumbleB Trust'),
        program_name: getSetting('program_name', 'Kalvi40'),
        contract_end_date: getSetting('contract_end_date', '30.04.2027'),
        stipend_text: getSetting('stipend_text', 'INR. 3000/- per month with effect from Oct 2026 as stipend.'),
        trust_address: getSetting('trust_address', 'No.63, 2nd Main Road, Sankarapuram, Sithalapakkam, Chennai - 600126.'),
        trust_regn: getSetting('trust_regn', '(A Public Charitable Trust / Regn. No.125 /2019 BKIV)'),
        trust_mobile: getSetting('trust_mobile', '+91 97910 07318'),
        trust_email: getSetting('trust_email', 'prem@bumbleb.org.in'),
        trust_website: getSetting('trust_website', 'www.bumbleb.org.in'),
        supabase_configured: Boolean(supabaseUrl && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) && !supabaseUrl.includes('your-project-ref')),
        supabase_url: supabaseUrl && !supabaseUrl.includes('your-project-ref') ? supabaseUrl : '',
      },
    });
  });

  router.put('/settings/general', async (req: AuthRequest, res) => {
    const allowedKeys = [
      'organization_name',
      'program_name',
      'contract_end_date',
      'stipend_text',
      'trust_address',
      'trust_regn',
      'trust_mobile',
      'trust_email',
      'trust_website',
    ];
    for (const key of allowedKeys) {
      if (req.body?.[key] !== undefined) {
        setSetting(key, String(req.body[key]).trim());
      }
    }

    // Invalidate cached PDFs so letterhead/contract/stipend edits appear immediately
    db.prepare(`UPDATE candidates SET offer_generated = 0, updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Settings were saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'GENERAL_SETTINGS_UPDATED',
      entityType: 'settings',
      details: 'Updated general organization and offer letter letterhead configuration.',
      ipAddress: getClientIp(req),
    });

    res.json({ message: 'General settings saved.' });
  });

  // =========================================================================
  // FOUNDER SIGNATURE UPLOAD & MANAGEMENT
  // =========================================================================
  router.get('/settings/signature', (_req, res) => {
    res.json({ signature: getFounderSignatureInfo() });
  });

  router.post('/settings/signature', async (req: AuthRequest, res) => {
    const rawDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const match = rawDataUrl.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      res.status(400).json({
        error: 'Invalid signature image format. Please upload a valid PNG or JPG image.',
      });
      return;
    }

    const base64Data = match[2].replace(/\s+/g, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 32) {
      res.status(400).json({ error: 'Uploaded signature image is empty or corrupted.' });
      return;
    }
    if (buffer.length > 5 * 1024 * 1024) {
      res.status(400).json({ error: 'Signature image must be 5 MB or smaller.' });
      return;
    }

    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (!isPng && !isJpg) {
      res.status(400).json({ error: 'Uploaded file is not a valid PNG or JPEG image.' });
      return;
    }

    const ext = isPng ? 'png' : 'jpg';
    const mime = isPng ? 'image/png' : 'image/jpeg';
    const filename = `founder_signature.${ext}`;

    // Remove any previous signature files before writing the new one
    for (const oldName of ['founder_signature.png', 'founder_signature.jpg', getSetting('founder_signature_filename', '')]) {
      const safeOld = path.basename(oldName || '');
      if (safeOld && safeOld !== filename) {
        const oldPath = path.join(uploadsStorageDir, safeOld);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }

    fs.writeFileSync(path.join(uploadsStorageDir, filename), buffer);

    setSetting('founder_signature_filename', filename);
    setSetting('founder_signature_mime', mime);
    if (req.body?.heightPt !== undefined) {
      const h = Math.max(24, Math.min(72, Math.round(Number(req.body.heightPt) || 40)));
      setSetting('founder_signature_height', String(h));
    }
    setSetting('founder_signature_updated_at', new Date().toISOString());

    // Mark all candidate PDFs stale so previews, downloads, and sends embed the new signature
    db.prepare(`UPDATE candidates SET offer_generated = 0, updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Signature metadata was saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'FOUNDER_SIGNATURE_UPLOADED',
      entityType: 'settings',
      details: `Uploaded custom Founder signature (${filename}, ${(buffer.length / 1024).toFixed(1)} KB).`,
      ipAddress: getClientIp(req),
    });

    res.json({
      message: 'Founder signature uploaded successfully.',
      signature: getFounderSignatureInfo(),
    });
  });

  router.put('/settings/signature/options', async (req: AuthRequest, res) => {
    const heightPt = Math.max(24, Math.min(72, Math.round(Number(req.body?.heightPt) || 40)));
    setSetting('founder_signature_height', String(heightPt));
    setSetting('founder_signature_updated_at', new Date().toISOString());

    db.prepare(`UPDATE candidates SET offer_generated = 0, updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Signature options were saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'FOUNDER_SIGNATURE_RESIZED',
      entityType: 'settings',
      details: `Updated Founder signature height to ${heightPt} pt.`,
      ipAddress: getClientIp(req),
    });

    res.json({
      message: 'Founder signature size updated.',
      signature: getFounderSignatureInfo(),
    });
  });

  router.delete('/settings/signature', async (req: AuthRequest, res) => {
    const existing = getSetting('founder_signature_filename', '').trim();
    for (const candidateFile of [existing, 'founder_signature.png', 'founder_signature.jpg']) {
      const safeName = path.basename(candidateFile || '');
      if (safeName) {
        const targetPath = path.join(uploadsStorageDir, safeName);
        if (fs.existsSync(targetPath)) {
          try {
            fs.unlinkSync(targetPath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }

    setSetting('founder_signature_filename', '');
    setSetting('founder_signature_mime', '');
    setSetting('founder_signature_updated_at', '');

    db.prepare(`UPDATE candidates SET offer_generated = 0, updated_at = datetime('now')`).run();

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Signature was removed locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'FOUNDER_SIGNATURE_REMOVED',
      entityType: 'settings',
      details: 'Removed uploaded Founder signature and restored default signature.',
      ipAddress: getClientIp(req),
    });

    res.json({
      message: 'Founder signature reset to default.',
      signature: getFounderSignatureInfo(),
    });
  });

  router.get('/settings/email', (_req, res) => {
    res.json({ config: getPublicEmailConfig() });
  });

  router.put('/settings/email', async (req: AuthRequest, res) => {
    const body = req.body || {};
    const nextHost = typeof body.smtp_host === 'string' ? body.smtp_host.trim() : getSetting('smtp_host', 'smtp.gmail.com');

    if (typeof body.smtp_host === 'string' && !isValidSmtpHost(nextHost)) {
      res.status(400).json({
        error: `Invalid SMTP Host "${nextHost}". Enter a mail server hostname such as smtp.gmail.com, not an email address.`,
      });
      return;
    }

    setSetting('email_provider', 'smtp');
    db.prepare(`DELETE FROM settings WHERE key = 'brevo_api_key'`).run();

    if (typeof body.sender_name === 'string') setSetting('sender_name', body.sender_name.trim());
    if (typeof body.sender_email === 'string') setSetting('sender_email', body.sender_email.trim());
    if (typeof body.reply_to === 'string') setSetting('reply_to', body.reply_to.trim());
    if (typeof body.smtp_host === 'string') setSetting('smtp_host', nextHost);
    if (typeof body.smtp_port === 'string' || typeof body.smtp_port === 'number') {
      const portNum = Math.max(1, Math.min(65535, Number(body.smtp_port) || 587));
      setSetting('smtp_port', String(portNum));
    }
    if (typeof body.smtp_user === 'string') setSetting('smtp_user', body.smtp_user.trim());
    if (typeof body.smtp_pass === 'string' && body.smtp_pass.trim() && !body.smtp_pass.includes('••••')) {
      setSetting('smtp_pass', normalizeSmtpPassword(nextHost, body.smtp_pass));
    }
    if (body.smtp_secure !== undefined) setSetting('smtp_secure', body.smtp_secure ? 'true' : 'false');
    if (body.rate_limit_per_minute !== undefined) {
      setSetting('rate_limit_per_minute', String(Math.max(1, Math.min(300, Number(body.rate_limit_per_minute) || 45))));
    }
    if (body.max_retries !== undefined) {
      setSetting('max_retries', String(Math.max(0, Math.min(5, Number(body.max_retries) || 3))));
    }

    const syncResult = await syncLocalSettingsToSupabase();
    if (!syncResult.ok) {
      res.status(503).json({ error: `Email settings were saved locally, but Supabase synchronization failed: ${syncResult.error}` });
      return;
    }

    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'EMAIL_CONFIG_UPDATED',
      entityType: 'settings',
      details: `Updated SMTP configuration (${getSetting('smtp_host')}:${getSetting('smtp_port')}, sender: ${getSetting('sender_email')})`,
      ipAddress: getClientIp(req),
    });

    res.json({ config: getPublicEmailConfig() });
  });

  router.post('/settings/email/test-connection', async (req: AuthRequest, res) => {
    const result = await verifyEmailProviderConnection();
    logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      action: 'EMAIL_CONNECTION_TEST',
      entityType: 'settings',
      details: result.ok
        ? `Verified ${result.provider} connection: ${result.accountInfo}`
        : `Connection test failed (${result.provider}): ${result.error}`,
      ipAddress: getClientIp(req),
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post('/settings/email/send-test', async (req: AuthRequest, res) => {
    const toEmail = String(req.body?.toEmail || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      res.status(400).json({ error: 'Provide a valid recipient email address for the test email.' });
      return;
    }

    const sampleCandidate = db.prepare('SELECT * FROM candidates ORDER BY id ASC LIMIT 1').get() as Candidate | undefined;
    const testTemplate = await getMasterTemplate();
    const mockSubject = `[Test] ${testTemplate.subject}`;
    const bodyText = sampleCandidate
      ? renderTemplateString(testTemplate.body, sampleCandidate)
      : 'Kalvi40 email provider verification test message.';

    let attachmentBuffer: Buffer = Buffer.from('Test attachment');
    let attachmentFilename = 'Kalvi40_Test_Offer.pdf';
    if (sampleCandidate) {
      const pdf = await generateOfferLetterPdf(sampleCandidate);
      attachmentBuffer = pdf.buffer;
      attachmentFilename = pdf.filename;
    }

    const result = await sendTransactionalOfferEmail({
      toEmail,
      toName: 'Kalvi40 Administrator Test',
      ccEmails: [],
      subject: mockSubject,
      bodyText,
      attachmentFilename,
      attachmentBuffer,
    });

    if (!result.success) {
      res.status(400).json({ error: result.errorMessage || 'Test email delivery failed.' });
      return;
    }

    res.json({
      message: `Test email with PDF attachment accepted by ${result.provider} (Message ID: ${result.messageId || 'N/A'}).`,
      messageId: result.messageId,
    });
  });

  // Helper endpoint to download a ready-to-import Excel template with sample columns
  router.get('/import/sample-excel', (_req, res) => {
    const rows = [
      {
        'Candidate Name': 'Sample Candidate One',
        'School Name': 'Sample Government Middle School',
        Location: 'Sample Town',
        District: 'Tiruvannamalai',
        'Mobile Number': '9000000001',
        Email: 'candidate1@example.org',
        'Joining Date': '21.10.2026',
      },
      {
        'Candidate Name': 'Sample Candidate Two',
        'School Name': 'Sample Girls Higher Secondary School',
        Location: 'Sample City',
        District: 'Chengalpattu',
        'Mobile Number': '9000000002',
        Email: 'candidate2@example.org',
        'Joining Date': '01.11.2026',
      },
      {
        'Candidate Name': 'Sample Candidate Three',
        'School Name': 'Sample Panchayat Union Middle School',
        Location: 'Sample Village',
        District: 'Villupuram',
        'Mobile Number': '9000000003',
        Email: 'candidate3@example.org',
        'Joining Date': '02.11.2026',
      },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Candidates');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Kalvi40_Candidate_Import_Template.xlsx"');
    res.send(buffer);
  });

  return router;
}
