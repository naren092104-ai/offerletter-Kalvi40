import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { requireSupabase, getSetting, setSettings, setRuntimeSecret, cacheSupabaseSettings, logActivity, normalizeCandidate, normalizeCcRecipient, normalizeCampaign } from './store.ts';
import { pdfStorageDir, uploadsStorageDir } from './storage.ts';
import { getPublicEmailConfig, isProviderConfigured, isValidSmtpHost, normalizeSmtpPassword, sendTransactionalOfferEmail, verifyEmailProviderConnection } from './emailService.ts';
import { buildOfferLetterPdfBuffer, generateOfferLetterPdf, getFounderSignatureInfo, getOfferLetterTemplate } from './pdfGenerator.ts';
import { triggerQueueWorker } from './queue.ts';
import { getMasterTemplate, verifyCandidateForSending } from './verification.ts';
import { DEFAULT_MASTER_BODY, DEFAULT_MASTER_SUBJECT, DEFAULT_OFFER_LETTER_TEMPLATE, formatDateDDMMYYYY, normalizeSchoolName, renderTemplateString, sanitizeOfferFilename, type AdminUser, type Candidate } from '../src/types/kalvi40.ts';

interface AuthRequest extends Request { admin?: AdminUser; }
const JWT_SECRET = process.env.JWT_SECRET || 'kalvi40-bumbleb-enterprise-secret-2026';
type AsyncHandler = (req: AuthRequest, res: Response) => Promise<unknown>;
const asyncRoute = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req as AuthRequest, res)).catch(next);
const now = () => new Date().toISOString();
const asCandidate = (row: any): Candidate => normalizeCandidate(row) as Candidate;
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const clientIp = (req: Request) => typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
const safeFilename = (name: string) => path.basename(name || '');
function sendError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'Supabase operation failed.';
  res.status(503).json({ error: message });
}
function signToken(admin: AdminUser) { return jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: '12h' }); }
async function recordActivity(req: AuthRequest, action: string, entityType: string, details: string, entityId?: number | string | null) {
  await logActivity({ adminId: req.admin?.id ?? null, adminEmail: req.admin?.email || 'unknown', action, entityType, entityId, details, ipAddress: clientIp(req) });
}
async function getCandidate(id: number): Promise<Candidate | null> {
  const { data, error } = await requireSupabase().from('candidates').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Unable to read candidate from Supabase: ${error.message}`);
  return data ? asCandidate(data) : null;
}
async function getCandidates(): Promise<Candidate[]> {
  const { data, error } = await requireSupabase().from('candidates').select('*').order('id', { ascending: true });
  if (error) throw new Error(`Unable to read candidates from Supabase: ${error.message}`);
  return (data ?? []).map(asCandidate);
}
async function getCc() {
  const { data, error } = await requireSupabase().from('cc_recipients').select('*').order('id', { ascending: true });
  if (error) throw new Error(`Unable to read CC recipients from Supabase: ${error.message}`);
  return (data ?? []).map(normalizeCcRecipient);
}
async function invalidateCandidatePdfs(): Promise<void> {
  const { error } = await requireSupabase().from('candidates').update({ offer_generated: false, verification_status: 'unverified', updated_at: now() }).neq('id', 0);
  if (error) throw new Error(`Unable to invalidate candidate PDFs in Supabase: ${error.message}`);
}
async function saveSettings(values: Record<string, string>): Promise<void> { await setSettings(values); }
async function removePdfFiles(rows: Array<{ offer_filename?: string | null; candidate_name?: string }>) {
  for (const row of rows) for (const name of [row.offer_filename, row.candidate_name ? sanitizeOfferFilename(row.candidate_name) : null]) {
    const filename = safeFilename(name || '');
    if (!filename) continue;
    try { fs.unlinkSync(path.join(pdfStorageDir, filename)); } catch { /* local cleanup is best effort */ }
  }
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'kalvi40-offer-automation', timestamp: now() }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) { res.status(400).json({ error: 'Email and password are required.' }); return; }
    const { data: row, error } = await requireSupabase().from('admins').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error(`Unable to authenticate against Supabase: ${error.message}`);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      await logActivity({ adminEmail: email || 'unknown', action: 'AUTH_LOGIN_FAILED', entityType: 'auth', details: `Failed sign-in attempt for ${email}`, ipAddress: clientIp(req) });
      res.status(401).json({ error: 'Invalid email address or password.' }); return;
    }
    const timestamp = now();
    const { error: updateError } = await requireSupabase().from('admins').update({ last_login_at: timestamp, updated_at: timestamp }).eq('id', row.id);
    if (updateError) throw new Error(`Unable to update administrator login time: ${updateError.message}`);
    const admin: AdminUser = { id: row.id, name: row.name, email: row.email, role: row.role, designation: row.designation, phone: row.phone, last_login_at: timestamp, created_at: row.created_at };
    await logActivity({ adminId: admin.id, adminEmail: email, action: 'AUTH_LOGIN', entityType: 'auth', entityId: admin.id, details: `Administrator ${admin.name} signed in.`, ipAddress: clientIp(req) });
    res.json({ token: signToken(admin), admin });
  }));

  router.post('/auth/forgot-password', asyncRoute(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) { res.status(400).json({ error: 'Email address is required.' }); return; }
    const { data: admin, error } = await requireSupabase().from('admins').select('id,name,email').eq('email', email).maybeSingle();
    if (error) throw new Error(`Unable to look up administrator in Supabase: ${error.message}`);
    if (!admin) { res.json({ message: 'If an administrator account matches that email, a password reset token has been generated.' }); return; }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { error: insertError } = await requireSupabase().from('password_resets').insert({ admin_id: admin.id, token, expires_at: expiresAt });
    if (insertError) throw new Error(`Unable to create Supabase password reset: ${insertError.message}`);
    await logActivity({ adminId: admin.id, adminEmail: email, action: 'AUTH_RESET_REQUESTED', entityType: 'auth', entityId: admin.id, details: `Password reset requested for ${email}`, ipAddress: clientIp(req) });
    const appUrl = process.env.APP_URL && !process.env.APP_URL.includes('MY_APP_URL') ? process.env.APP_URL : `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${appUrl}/?resetToken=${token}`;
    let emailed = false;
    if (isProviderConfigured()) {
      const result = await sendTransactionalOfferEmail({ toEmail: email, toName: admin.name, ccEmails: [], subject: 'Kalvi40 Admin Password Reset', bodyText: `Hello ${admin.name},\n\nUse this link within 30 minutes to reset your password:\n${resetUrl}\n\nIf you did not request this, ignore this message.`, attachmentFilename: 'reset_notice.txt', attachmentBuffer: Buffer.from(`Reset link: ${resetUrl}`) });
      emailed = result.success;
    }
    res.json({ message: emailed ? 'Password reset instructions have been emailed to your administrator address.' : 'Email provider is not yet configured; use the secure one-time reset token below to complete your reset.', emailed, ...(emailed ? {} : { resetToken: token }) });
  }));

  router.post('/auth/reset-password', asyncRoute(async (req, res) => {
    const token = String(req.body?.token || '').trim(); const password = String(req.body?.newPassword || '');
    if (!token || password.length < 8) { res.status(400).json({ error: 'Valid reset token and a new password (minimum 8 characters) are required.' }); return; }
    const supabase = requireSupabase();
    const { data: reset, error } = await supabase.from('password_resets').select('*').eq('token', token).is('used_at', null).maybeSingle();
    if (error) throw new Error(`Unable to validate reset token: ${error.message}`);
    if (!reset || new Date(reset.expires_at).getTime() < Date.now()) { res.status(400).json({ error: 'Reset token is invalid or has expired.' }); return; }
    const { data: admin, error: adminError } = await supabase.from('admins').select('email').eq('id', reset.admin_id).maybeSingle();
    if (adminError || !admin) throw new Error('Unable to load administrator for password reset.');
    const timestamp = now();
    const { error: updateError } = await supabase.from('admins').update({ password_hash: bcrypt.hashSync(password, 10), updated_at: timestamp }).eq('id', reset.admin_id);
    if (updateError) throw new Error(`Unable to update administrator password: ${updateError.message}`);
    const { error: usedError } = await supabase.from('password_resets').update({ used_at: timestamp }).eq('id', reset.id);
    if (usedError) throw new Error(`Password changed but reset token could not be marked used: ${usedError.message}`);
    await logActivity({ adminId: reset.admin_id, adminEmail: admin.email, action: 'AUTH_PASSWORD_RESET', entityType: 'auth', entityId: reset.admin_id, details: 'Administrator password reset completed.', ipAddress: clientIp(req) });
    res.json({ message: 'Password updated successfully. You may now sign in.' });
  }));

  // Express middleware must call next after the asynchronous auth check.
  router.use((req, res, next) => {
    void (async () => {
      const auth = req.headers.authorization;
      const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
      const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : queryToken;
      if (!raw) { res.status(401).json({ error: 'Authentication required. Please sign in.' }); return; }
      let decoded: { id: number };
      try { decoded = jwt.verify(raw, JWT_SECRET) as { id: number }; } catch { res.status(401).json({ error: 'Session expired. Please sign in again.' }); return; }
      const { data, error } = await requireSupabase().from('admins').select('id,name,email,role,designation,phone,last_login_at,created_at').eq('id', decoded.id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) { res.status(401).json({ error: 'Administrator session is invalid or expired.' }); return; }
      (req as AuthRequest).admin = data as AdminUser;
      next();
    })().catch((error) => next(error));
  });
  router.get('/auth/me', (req: AuthRequest, res) => res.json({ admin: req.admin }));

  router.put('/auth/profile', asyncRoute(async (req, res) => {
    const admin = req.admin!; const name = String(req.body?.name || '').trim(); const email = String(req.body?.email || '').trim().toLowerCase();
    const designation = String(req.body?.designation || '').trim(); const phone = String(req.body?.phone || '').trim();
    if (!name || !email) { res.status(400).json({ error: 'Name and email are required.' }); return; }
    const supabase = requireSupabase();
    const { data: conflict, error: checkError } = await supabase.from('admins').select('id').eq('email', email).neq('id', admin.id).maybeSingle();
    if (checkError) throw new Error(checkError.message);
    if (conflict) { res.status(409).json({ error: 'Another administrator already uses this email.' }); return; }
    const { data, error } = await supabase.from('admins').update({ name, email, designation, phone, updated_at: now() }).eq('id', admin.id).select('id,name,email,role,designation,phone,last_login_at,created_at').single();
    if (error) throw new Error(`Unable to update administrator profile: ${error.message}`);
    await recordActivity(req, 'PROFILE_UPDATED', 'admin', `Updated administrator profile (${name})`, admin.id);
    res.json({ admin: data });
  }));
  router.put('/auth/password', asyncRoute(async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || ''); const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || newPassword.length < 8) { res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' }); return; }
    const { data: row, error } = await requireSupabase().from('admins').select('password_hash').eq('id', req.admin!.id).single();
    if (error) throw new Error(error.message);
    if (!bcrypt.compareSync(currentPassword, row.password_hash)) { res.status(400).json({ error: 'Current password is incorrect.' }); return; }
    const { error: updateError } = await requireSupabase().from('admins').update({ password_hash: bcrypt.hashSync(newPassword, 10), updated_at: now() }).eq('id', req.admin!.id);
    if (updateError) throw new Error(updateError.message);
    await recordActivity(req, 'PASSWORD_CHANGED', 'admin', 'Administrator password updated.', req.admin!.id);
    res.json({ message: 'Password updated successfully.' });
  }));

  router.get('/dashboard', asyncRoute(async (_req, res) => {
    const supabase = requireSupabase();
    const [candidatesRes, historyRes, logsRes, campaignsRes] = await Promise.all([
      supabase.from('candidates').select('id,district,offer_generated,created_at'), supabase.from('send_history').select('status,created_at'),
      supabase.from('activity_logs').select('*').order('id', { ascending: false }).limit(10), supabase.from('campaigns').select('*').order('id', { ascending: false }).limit(6),
    ]);
    for (const result of [candidatesRes, historyRes, logsRes, campaignsRes]) if (result.error) throw new Error(result.error.message);
    const candidates = candidatesRes.data ?? []; const history = historyRes.data ?? [];
    const monthly = new Map<string, { month: string; sent: number; failed: number; pending: number }>();
    for (const item of history) { const month = String(item.created_at || '').slice(0, 7); if (!month) continue; const entry = monthly.get(month) ?? { month, sent: 0, failed: 0, pending: 0 }; if (item.status === 'sent') entry.sent++; else if (item.status === 'failed') entry.failed++; else entry.pending++; monthly.set(month, entry); }
    const districts = new Map<string, { district: string; count: number; offers_generated: number }>();
    for (const c of candidates) { const key = c.district || ''; const entry = districts.get(key) ?? { district: key, count: 0, offers_generated: 0 }; entry.count++; if (c.offer_generated) entry.offers_generated++; districts.set(key, entry); }
    res.json({ kpis: { totalCandidates: candidates.length, totalOffersGenerated: candidates.filter((c) => c.offer_generated).length, emailsSent: history.filter((h) => h.status === 'sent').length, emailsPending: history.filter((h) => h.status === 'pending' || h.status === 'processing').length, emailsFailed: history.filter((h) => h.status === 'failed').length }, districtDistribution: [...districts.values()].sort((a,b) => b.count-a.count).slice(0,12), monthlyActivity: [...monthly.values()].sort((a,b) => a.month.localeCompare(b.month)).slice(-12), recentActivities: logsRes.data, recentCampaigns: (campaignsRes.data ?? []).map(normalizeCampaign), providerConfigured: isProviderConfigured() });
  }));

  router.get('/reports', asyncRoute(async (_req, res) => {
    const supabase = requireSupabase(); const [cRes, hRes, campRes] = await Promise.all([supabase.from('candidates').select('*'), supabase.from('send_history').select('*'), supabase.from('campaigns').select('*').order('id', { ascending: false }).limit(25)]);
    for (const result of [cRes,hRes,campRes]) if (result.error) throw new Error(result.error.message);
    const candidates = cRes.data ?? []; const history = hRes.data ?? []; const sent = history.filter((x) => x.status === 'sent').length; const failed = history.filter((x) => x.status === 'failed').length; const pending = history.filter((x) => x.status === 'pending' || x.status === 'processing').length;
    const group = (keyOf: (c: any) => string) => { const map = new Map<string, any>(); for (const c of candidates) { const key = keyOf(c); const value = map.get(key) ?? { candidates: 0, offers_generated: 0, emails_sent: 0, emails_failed: 0 }; value.candidates++; if (c.offer_generated) value.offers_generated++; const candidateHistory = history.filter((h) => h.candidate_id === c.id); if (candidateHistory.some((h) => h.status === 'sent')) value.emails_sent++; if (candidateHistory.some((h) => h.status === 'failed')) value.emails_failed++; map.set(key, value); } return map; };
    const districtMap = group((c) => c.district || ''); const districtReports = [...districtMap].map(([district, v]) => ({ district, ...v })).sort((a,b) => b.candidates-a.candidates);
    const schoolMap = group((c) => `${c.school_name}\u0000${c.location}\u0000${c.district}`); const schoolReports = [...schoolMap].map(([key,v]) => { const [school_name, location, district] = key.split('\u0000'); return { school_name, location, district, candidates: v.candidates, offers_generated: v.offers_generated, emails_sent: v.emails_sent }; }).sort((a,b) => b.candidates-a.candidates || String(a.school_name).localeCompare(String(b.school_name)));
    const monthlyMap = new Map<string, any>(); for (const c of candidates) { const month = String(c.created_at || '').slice(0,7); if (!month) continue; const value = monthlyMap.get(month) ?? { month, candidates_added: 0, offers_generated: 0 }; value.candidates_added++; if (c.offer_generated) value.offers_generated++; monthlyMap.set(month,value); }
    res.json({ summary: { totalCandidates: candidates.length, totalOffers: candidates.filter((c) => c.offer_generated).length, sentEmails: sent, failedEmails: failed, pendingEmails: pending, successRate: sent + failed ? Number((sent / (sent + failed) * 100).toFixed(1)) : 0 }, districtReports, schoolReports, monthlyTrends: [...monthlyMap.values()].sort((a,b) => a.month.localeCompare(b.month)), campaignPerformance: (campRes.data ?? []).map(normalizeCampaign) });
  }));

  router.get('/reports/export', asyncRoute(async (_req, res) => {
    const supabase = requireSupabase(); const [cRes,hRes] = await Promise.all([supabase.from('candidates').select('*').order('id',{ascending:false}), supabase.from('send_history').select('*').order('id',{ascending:false})]);
    if (cRes.error || hRes.error) throw new Error(cRes.error?.message || hRes.error?.message);
    const candidates = cRes.data ?? []; const history = hRes.data ?? []; const districtMap = new Map<string, any>();
    for (const c of candidates) { const row = districtMap.get(c.district) ?? { District: c.district, 'Total Candidates': 0, 'Offers Generated': 0, 'Emails Sent': 0 }; row['Total Candidates']++; if (c.offer_generated) row['Offers Generated']++; if (history.some((h) => h.candidate_id === c.id && h.status === 'sent')) row['Emails Sent']++; districtMap.set(c.district,row); }
    const candidateRows = candidates.map((c) => ({ ID:c.id,'Candidate Name':c.candidate_name,'School Name':c.school_name,Location:c.location,District:c.district,'Phone Number':c.phone,Email:c.email,'Joining Date':c.joining_date,'PDF Status':c.offer_generated?'Generated':'Not Generated','PDF Filename':c.offer_filename,'Verification Status':c.verification_status }));
    const historyRows = history.map((h) => ({ 'Batch ID':h.batch_code,'Candidate Name':h.candidate_name,Email:h.candidate_email,CC:h.cc_emails,'PDF Filename':h.pdf_filename,Status:h.status,'Delivery State':h.delivery_status,Provider:h.provider,'Sent At':h.sent_at,'Error Details':h.error_message }));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(candidateRows.length?candidateRows:[{Notice:'No candidate records'}]),'Candidates'); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([...districtMap.values()]),'District Summary'); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(historyRows.length?historyRows:[{Notice:'No sending records'}]),'Sending History');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition','attachment; filename="Kalvi40_Analytics_Report.xlsx"'); res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));
  }));

  router.get('/candidates', asyncRoute(async (req,res) => {
    const search=String(req.query.search||'').trim().toLowerCase(); const district=String(req.query.district||'').trim(); const offer=String(req.query.offerStatus||''); const page=Math.max(1,Number(req.query.page||1)); const pageSize=Math.min(200,Math.max(5,Number(req.query.pageSize||15))); const all=req.query.all==='true';
    const sortCols: Record<string,string>={id:'id',candidate_name:'candidate_name',school_name:'school_name',district:'district',joining_date:'joining_date',created_at:'created_at'}; const sort=sortCols[String(req.query.sortBy||'id')]||'id'; const asc=String(req.query.sortDir||'desc').toLowerCase()==='asc';
    let items=await getCandidates(); const {data:hist,error}=await requireSupabase().from('send_history').select('candidate_id,status,id').order('id',{ascending:false}); if(error) throw new Error(error.message);
    const lastStatus=new Map<number,string>(); for(const h of hist??[]) if(!lastStatus.has(h.candidate_id)) lastStatus.set(h.candidate_id,h.status);
    items=items.map((c)=>({...c,last_send_status:lastStatus.get(c.id)??null}));
    if(search) items=items.filter((c)=>[c.candidate_name,c.school_name,c.location,c.district,c.phone,c.email].some((v)=>String(v||'').toLowerCase().includes(search)));
    if(district&&district!=='all') items=items.filter((c)=>c.district===district); if(offer==='generated') items=items.filter((c)=>Boolean(c.offer_generated)); if(offer==='pending') items=items.filter((c)=>!c.offer_generated);
    items.sort((a:any,b:any)=>{const x=a[sort],y=b[sort]; const cmp=typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??'')); return asc?cmp:-cmp;});
    const total=items.length; const districts=[...new Set((await getCandidates()).map((c)=>c.district))].sort(); if(!all) items=items.slice((page-1)*pageSize,page*pageSize);
    res.json({items,total,page,pageSize,districts});
  }));
  router.get('/candidates/:id', asyncRoute(async (req,res)=>{ const candidate=await getCandidate(Number(req.params.id)); if(!candidate){res.status(404).json({error:'Candidate not found.'});return;} const {data:history,error}=await requireSupabase().from('send_history').select('status').eq('candidate_id',candidate.id).order('id',{ascending:false}).limit(1).maybeSingle(); if(error) throw new Error(error.message); res.json({candidate:{...candidate,last_send_status:history?.status??null}}); }));
  router.post('/candidates', asyncRoute(async(req,res)=>{
    const b=req.body||{}; const candidate={candidate_name:String(b.candidate_name||'').trim(),school_name:normalizeSchoolName(String(b.school_name||'')),location:String(b.location||'').trim(),district:String(b.district||'').trim(),phone:String(b.phone||'').trim(),email:String(b.email||'').trim().toLowerCase(),joining_date:formatDateDDMMYYYY(String(b.joining_date||'').trim()),custom_offer_body:typeof b.custom_offer_body==='string'&&b.custom_offer_body.trim()?b.custom_offer_body.trim():null};
    if(!candidate.candidate_name||!candidate.school_name||!candidate.location||!candidate.district||!candidate.phone||!candidate.email||!candidate.joining_date){res.status(400).json({error:'All 7 candidate fields are required.'});return;} if(!validEmail(candidate.email)){res.status(400).json({error:'Please provide a valid candidate email address.'});return;}
    const supabase=requireSupabase(); const {data:duplicate,error:checkError}=await supabase.from('candidates').select('id,candidate_name').eq('email',candidate.email).maybeSingle(); if(checkError) throw new Error(checkError.message); if(duplicate){res.status(409).json({error:`Duplicate email detected: "${candidate.email}" is already assigned to ${duplicate.candidate_name}.`});return;}
    const {data,error}=await supabase.from('candidates').insert(candidate).select('*').single(); if(error) throw new Error(`Unable to create candidate in Supabase: ${error.message}`); const created=asCandidate(data); await recordActivity(req,'CANDIDATE_CREATED','candidate',`Added candidate ${created.candidate_name} (${created.email}) for ${created.school_name}, ${created.district}`,created.id); res.status(201).json({candidate:created});
  }));
  router.put('/candidates/:id',asyncRoute(async(req,res)=>{
    const id=Number(req.params.id); const existing=await getCandidate(id); if(!existing){res.status(404).json({error:'Candidate not found.'});return;} const b=req.body||{};
    const email=String(b.email||'').trim().toLowerCase(); const patch={candidate_name:String(b.candidate_name||'').trim(),school_name:normalizeSchoolName(String(b.school_name||'')),location:String(b.location||'').trim(),district:String(b.district||'').trim(),phone:String(b.phone||'').trim(),email,joining_date:formatDateDDMMYYYY(String(b.joining_date||'').trim()),custom_offer_body:Object.prototype.hasOwnProperty.call(b,'custom_offer_body')?(typeof b.custom_offer_body==='string'&&b.custom_offer_body.trim()?b.custom_offer_body.trim():null):existing.custom_offer_body??null,offer_generated:false,verification_status:'unverified',verification_issues:null,updated_at:now()};
    if(!patch.candidate_name||!patch.school_name||!patch.location||!patch.district||!email||!patch.joining_date){res.status(400).json({error:'All 6 candidate fields are required.'});return;} if(!validEmail(email)){res.status(400).json({error:'Invalid email address format.'});return;}
    const supabase=requireSupabase(); const {data:dup,error:dupError}=await supabase.from('candidates').select('id,candidate_name').eq('email',email).neq('id',id).maybeSingle(); if(dupError)throw new Error(dupError.message);if(dup){res.status(409).json({error:`Duplicate email detected: "${email}" belongs to ${dup.candidate_name}.`});return;}
    const {data,error}=await supabase.from('candidates').update(patch).eq('id',id).select('*').maybeSingle();if(error)throw new Error(error.message);if(!data){res.status(404).json({error:'Candidate not found.'});return;}const updated=asCandidate(data);await recordActivity(req,'CANDIDATE_UPDATED','candidate',`Updated candidate ${updated.candidate_name} (${updated.email}); PDF regeneration queued on next preview/send.`,id);res.json({candidate:updated});
  }));
  router.put('/candidates/:id/offer-content',asyncRoute(async(req,res)=>{const id=Number(req.params.id);const candidate=await getCandidate(id);if(!candidate){res.status(404).json({error:'Candidate not found.'});return;}const body=typeof req.body?.custom_offer_body==='string'?req.body.custom_offer_body.trim()||null:null;const {error}=await requireSupabase().from('candidates').update({custom_offer_body:body,offer_generated:false,verification_status:'unverified',verification_issues:null,updated_at:now()}).eq('id',id);if(error)throw new Error(error.message);const updated=await getCandidate(id);const pdf=await generateOfferLetterPdf(updated!);const refreshed=await getCandidate(id);await recordActivity(req,'CANDIDATE_OFFER_CONTENT_UPDATED','candidate',`Saved offer content and regenerated ${pdf.filename} for ${candidate.candidate_name}.`,id);res.json({candidate:refreshed,filename:pdf.filename});}));
  router.delete('/candidates/:id',asyncRoute(async(req,res)=>{const id=Number(req.params.id);const c=await getCandidate(id);if(!c){res.status(404).json({error:'Candidate not found.'});return;}const {error}=await requireSupabase().from('candidates').delete().eq('id',id);if(error)throw new Error(`Unable to delete candidate from Supabase: ${error.message}`);await removePdfFiles([c]);await recordActivity(req,'CANDIDATE_DELETED','candidate',`Deleted candidate ${c.candidate_name} (${c.email})`,id);res.json({message:'Candidate deleted.'});}));
  router.post('/candidates/bulk-delete',asyncRoute(async(req,res)=>{const deleteAll=Boolean(req.body?.deleteAll);const ids=Array.isArray(req.body?.candidateIds)?req.body.candidateIds.map(Number).filter(Boolean):[];if(!deleteAll&&!ids.length){res.status(400).json({error:'Select candidates to delete or specify deleteAll.'});return;}const supabase=requireSupabase();let query=supabase.from('candidates').select('id,candidate_name,offer_filename');if(!deleteAll)query=query.in('id',ids);const {data:targets,error:readError}=await query;if(readError)throw new Error(readError.message);if(!targets?.length){res.json({deletedCount:0,message:'No candidates to delete.'});return;}let deletion=supabase.from('candidates').delete();deletion=deleteAll?deletion.not('id','is',null):deletion.in('id',targets.map((x)=>x.id));const {error}=await deletion;if(error)throw new Error(error.message);await removePdfFiles(targets);await recordActivity(req,deleteAll?'CANDIDATES_CLEARED':'CANDIDATES_BULK_DELETED','candidate',`Removed ${targets.length} candidate record(s)${deleteAll?' (cleared directory)':''}.`);res.json({deletedCount:targets.length,message:`Removed ${targets.length} candidate(s).`});}));
  router.post('/candidates/bulk-import',asyncRoute(async(req,res)=>{const records=Array.isArray(req.body?.records)?req.body.records:[];const skip=req.body?.skipDuplicates!==false;if(!records.length){res.status(400).json({error:'No candidate records supplied for import.'});return;}const ids:number[]=[];const skipped:Array<{email:string;reason:string}>=[];const valid:Array<{candidate:Record<string,string>;existing:boolean}>=[];const supabase=requireSupabase();
    for(const raw of records){const c={candidate_name:String(raw.candidate_name||'').trim(),school_name:normalizeSchoolName(String(raw.school_name||'')),location:String(raw.location||'').trim(),district:String(raw.district||'').trim(),phone:String(raw.phone||'').trim(),email:String(raw.email||'').trim().toLowerCase(),joining_date:formatDateDDMMYYYY(String(raw.joining_date||'').trim())};if(!c.candidate_name||!c.school_name||!c.location||!c.district||!c.phone||!c.email||!c.joining_date){skipped.push({email:c.email||'(blank)',reason:'Missing required fields'});continue;}if(!validEmail(c.email)){skipped.push({email:c.email,reason:'Invalid email format'});continue;}const {data:existing,error:lookupError}=await supabase.from('candidates').select('id').eq('email',c.email).maybeSingle();if(lookupError)throw new Error(lookupError.message);if(existing&&skip){skipped.push({email:c.email,reason:'Duplicate email already exists in database'});continue;}valid.push({candidate:c,existing:Boolean(existing)});}
    const recordsToWrite=valid.filter((entry)=>!entry.existing||!skip).map((entry)=>entry.candidate);if(recordsToWrite.length){const {data:upserted,error}=await supabase.rpc('kalvi40_bulk_upsert_candidates',{p_candidates:recordsToWrite});if(error)throw new Error(`Atomic Supabase bulk import failed: ${error.message}`);ids.push(...(upserted??[]).map((row:any)=>Number(typeof row==='number'?row:row.kalvi40_bulk_upsert_candidates??Object.values(row)[0])).filter(Number.isFinite));}
    await recordActivity(req,'BULK_IMPORT','candidate',`Imported ${ids.length} candidate(s); skipped ${skipped.length} duplicate/invalid row(s).`);res.status(201).json({importedCount:ids.length,skippedCount:skipped.length,skipped,importedIds:ids});
  }));
  router.post('/candidates/:id/generate-pdf',asyncRoute(async(req,res)=>{const c=await getCandidate(Number(req.params.id));if(!c){res.status(404).json({error:'Candidate not found.'});return;}const result=await generateOfferLetterPdf(c);const updated=await getCandidate(c.id);await recordActivity(req,'PDF_GENERATED','candidate',`Generated offer letter PDF ${result.filename} for ${c.candidate_name}`,c.id);res.json({filename:result.filename,sizeBytes:result.buffer.length,candidate:updated});}));
  router.post('/candidates/bulk-generate-pdfs',asyncRoute(async(req,res)=>{const ids=Array.isArray(req.body?.candidateIds)?req.body.candidateIds.map(Number):[];const candidates=await getCandidates();const targets=ids.length?candidates.filter((c)=>ids.includes(c.id)):candidates;if(!targets.length){res.status(400).json({error:'No candidates selected for PDF generation.'});return;}const generated=[];for(const c of targets){const pdf=await generateOfferLetterPdf(c);generated.push({id:c.id,name:c.candidate_name,filename:pdf.filename});}await recordActivity(req,'BULK_PDF_GENERATED','candidate',`Generated ${generated.length} personalized offer letter PDFs.`);res.json({generatedCount:generated.length,files:generated});}));
  router.get('/candidates/:id/pdf',asyncRoute(async(req,res)=>{const c=await getCandidate(Number(req.params.id));if(!c){res.status(404).json({error:'Candidate not found.'});return;}const filename=sanitizeOfferFilename(c.candidate_name);const file=path.join(pdfStorageDir,filename);let buffer:Buffer;if(!c.offer_generated||!fs.existsSync(file)||req.query.refresh==='1')buffer=(await generateOfferLetterPdf(c)).buffer;else buffer=fs.readFileSync(file);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${filename}"`);res.send(buffer);}));
  router.get('/candidates/:id/verify',asyncRoute(async(req,res)=>{const c=await getCandidate(Number(req.params.id));if(!c){res.status(404).json({error:'Candidate not found.'});return;}res.json(await verifyCandidateForSending(c,{ensurePdfGenerated:true}));}));
  router.post('/candidates/verify-batch',asyncRoute(async(req,res)=>{const ids=Array.isArray(req.body?.candidateIds)?req.body.candidateIds.map(Number):[];if(!ids.length){res.status(400).json({error:'Select at least one candidate to verify.'});return;}const candidates=(await getCandidates()).filter((c)=>ids.includes(c.id));const override=req.body?.subject&&req.body?.body?{subject:String(req.body.subject),body:String(req.body.body)}:undefined;const results=[];for(const candidate of candidates)results.push({candidate,verification:await verifyCandidateForSending(candidate,{ensurePdfGenerated:true,templateOverride:override})});const validCount=results.filter((x)=>x.verification.valid).length;res.json({total:results.length,validCount,invalidCount:results.length-validCount,results});}));

  router.get('/templates/master',asyncRoute(async(_req,res)=>res.json({template:await getMasterTemplate()})));
  router.put('/templates/master',asyncRoute(async(req,res)=>{const subject=String(req.body?.subject||'').trim(),body=String(req.body?.body||'').trim();if(!subject||!body){res.status(400).json({error:'Email subject and body cannot be empty.'});return;}const current=await getMasterTemplate();const {data,error}=await requireSupabase().from('email_templates').update({subject,body,updated_by:req.admin!.email,updated_at:now()}).eq('id',current.id).select('*').single();if(error)throw new Error(error.message);await recordActivity(req,'TEMPLATE_UPDATED','email_template',`Updated master email template subject: "${subject}"`,current.id);res.json({template:{...data,is_master:data.is_master?1:0}});}));
  router.post('/templates/master/reset',asyncRoute(async(req,res)=>{const current=await getMasterTemplate();const {data,error}=await requireSupabase().from('email_templates').update({subject:DEFAULT_MASTER_SUBJECT,body:DEFAULT_MASTER_BODY,updated_by:req.admin!.email,updated_at:now()}).eq('id',current.id).select('*').single();if(error)throw new Error(error.message);await recordActivity(req,'TEMPLATE_RESET','email_template','Reset master email template to Kalvi40 default content.',current.id);res.json({template:{...data,is_master:data.is_master?1:0}});}));
  router.get('/templates/offer',(_req,res)=>res.json({template:getOfferLetterTemplate()}));
  router.put('/templates/offer',asyncRoute(async(req,res)=>{const b=req.body||{};const heading=String(b.heading??'').trim(),body=String(b.body??'').trim();if(!heading||!body){res.status(400).json({error:'Offer letter heading and body content cannot be empty.'});return;}const pairs:Record<string,string>={offer_heading:heading,offer_body:body};const mapping:Record<string,string>={header_name:'offer_header_name',header_role:'offer_header_role',brand_title:'offer_brand_title',brand_subtitle:'offer_brand_subtitle',trust_regn:'trust_regn',trust_address:'trust_address',trust_mobile:'trust_mobile',trust_email:'trust_email',trust_website:'trust_website',greeting:'offer_greeting',closing:'offer_closing',signatory_title:'offer_signatory_title',signatory_org:'offer_signatory_org',contract_end_date:'contract_end_date',stipend_text:'stipend_text',footer_left_url:'offer_footer_left_url',footer_right_url:'offer_footer_right_url'};for(const [field,key] of Object.entries(mapping))if(typeof b[field]==='string'&&b[field].trim())pairs[key]=b[field].trim();if(b.body_font_size!==undefined){const n=Number(b.body_font_size);if(Number.isFinite(n))pairs.offer_body_font_size=String(Math.max(9,Math.min(12.5,Number(n.toFixed(1)))));}await saveSettings(pairs);await invalidateCandidatePdfs();await recordActivity(req,'OFFER_TEMPLATE_UPDATED','offer_template',`Updated master offer letter PDF template ("${heading}"). Existing PDFs queued for fresh generation.`);res.json({template:getOfferLetterTemplate()});}));
  router.post('/templates/offer/preview-pdf',asyncRoute(async(req,res)=>{const draft=req.body?.template&&typeof req.body.template==='object'?req.body.template:{};const id=Number(req.body?.candidateId||0);const candidates=await getCandidates();const c=(id?candidates.find((x)=>x.id===id):candidates[0])||{candidate_name:'E Sathiya Kaviya',school_name:'Govt Panchayat Union Middle School',location:'Pattiyandal',district:'Tiruvannamalai',email:'candidate@example.com',joining_date:'21.10.2026',custom_offer_body:null};const {buffer,filename}=await buildOfferLetterPdfBuffer({...c,custom_offer_body:null} as any,draft);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="${filename}"`);res.send(buffer);}));
  router.post('/templates/offer/reset',asyncRoute(async(req,res)=>{const t=DEFAULT_OFFER_LETTER_TEMPLATE;await saveSettings({offer_header_name:t.header_name,offer_header_role:t.header_role,offer_brand_title:t.brand_title,offer_brand_subtitle:t.brand_subtitle,trust_regn:t.trust_regn,trust_address:t.trust_address,trust_mobile:t.trust_mobile,trust_email:t.trust_email,trust_website:t.trust_website,offer_heading:t.heading,offer_greeting:t.greeting,offer_body:t.body,offer_closing:t.closing,offer_signatory_title:t.signatory_title,offer_signatory_org:t.signatory_org,contract_end_date:t.contract_end_date,stipend_text:t.stipend_text,offer_footer_left_url:t.footer_left_url,offer_footer_right_url:t.footer_right_url,offer_body_font_size:String(t.body_font_size)});await invalidateCandidatePdfs();await recordActivity(req,'OFFER_TEMPLATE_RESET','offer_template','Reset master offer letter PDF template to original BumbleB Trust default.');res.json({template:getOfferLetterTemplate()});}));

  router.get('/cc',asyncRoute(async(_req,res)=>res.json({items:await getCc()})));
  router.post('/cc',asyncRoute(async(req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase(),label=String(req.body?.label||'').trim(),is_default=req.body?.is_default===false?false:true;if(!validEmail(email)){res.status(400).json({error:'Please provide a valid CC email address.'});return;}const supabase=requireSupabase();const {data:existing,error:lookup}=await supabase.from('cc_recipients').select('id').eq('email',email).maybeSingle();if(lookup)throw new Error(lookup.message);if(existing){res.status(409).json({error:`"${email}" is already in the CC list.`});return;}const {data,error}=await supabase.from('cc_recipients').insert({email,label,enabled:true,is_default}).select('*').single();if(error)throw new Error(error.message);const item=normalizeCcRecipient(data);await recordActivity(req,'CC_ADDED','cc_recipient',`Added CC recipient ${email} (${label||'No label'})`,item.id);res.status(201).json({item});}));
  router.put('/cc/:id',asyncRoute(async(req,res)=>{const id=Number(req.params.id),supabase=requireSupabase();const {data:existing,error:lookup}=await supabase.from('cc_recipients').select('*').eq('id',id).maybeSingle();if(lookup)throw new Error(lookup.message);if(!existing){res.status(404).json({error:'CC recipient not found.'});return;}const email=req.body?.email!==undefined?String(req.body.email).trim().toLowerCase():existing.email;if(!validEmail(email)){res.status(400).json({error:'Invalid CC email address.'});return;}const patch={email,label:req.body?.label!==undefined?String(req.body.label).trim():existing.label,enabled:req.body?.enabled!==undefined?Boolean(req.body.enabled):existing.enabled,is_default:req.body?.is_default!==undefined?Boolean(req.body.is_default):existing.is_default};const {data,error}=await supabase.from('cc_recipients').update(patch).eq('id',id).select('*').single();if(error)throw new Error(error.message);const item=normalizeCcRecipient(data);await recordActivity(req,'CC_UPDATED','cc_recipient',`Updated CC recipient ${item.email} (enabled: ${Boolean(item.enabled)})`,id);res.json({item});}));
  router.delete('/cc/:id',asyncRoute(async(req,res)=>{const id=Number(req.params.id),supabase=requireSupabase();const {data:existing,error:lookup}=await supabase.from('cc_recipients').select('email').eq('id',id).maybeSingle();if(lookup)throw new Error(lookup.message);if(!existing){res.status(404).json({error:'CC recipient not found.'});return;}const {error}=await supabase.from('cc_recipients').delete().eq('id',id);if(error)throw new Error(error.message);await recordActivity(req,'CC_DELETED','cc_recipient',`Removed CC recipient ${existing.email}`,id);res.json({message:'CC recipient removed.'});}));

  router.post('/send/individual',asyncRoute(async(req,res)=>{const candidateId=Number(req.body?.candidateId),candidate=await getCandidate(candidateId),allowResend=Boolean(req.body?.allowResend);if(!candidate){res.status(404).json({error:'Candidate not found.'});return;}if(!isProviderConfigured()){res.status(400).json({error:'SMTP credentials are not configured. Configure your SMTP settings in Email Configuration before sending.'});return;}const supabase=requireSupabase();if(!allowResend){const {data:sent,error}=await supabase.from('send_history').select('id,batch_code,sent_at').eq('candidate_id',candidateId).eq('status','sent').limit(1).maybeSingle();if(error)throw new Error(error.message);if(sent){res.status(409).json({error:`An offer email was already sent to ${candidate.email} in ${sent.batch_code}. Confirm "Allow Resend" if you intend to send a duplicate.`});return;}}const verification=await verifyCandidateForSending(candidate,{ensurePdfGenerated:true});if(!verification.valid){res.status(422).json({error:`Verification failed: ${verification.issues.join(' | ')}`,verification});return;}const cc=Array.isArray(req.body?.ccEmails)?req.body.ccEmails.map(String):(await getCc()).filter((x)=>x.enabled&&x.is_default).map((x)=>x.email);const filename=verification.pdfFilename;const buffer=fs.readFileSync(path.join(pdfStorageDir,filename));const batchCode=`IND-${now().slice(0,10).replace(/-/g,'')}-${Math.floor(100+Math.random()*900)}`;const result=await sendTransactionalOfferEmail({toEmail:candidate.email,toName:candidate.candidate_name,ccEmails:cc,subject:verification.renderedSubject,bodyText:verification.renderedBody,attachmentFilename:filename,attachmentBuffer:buffer});const {data:history,error}=await supabase.from('send_history').insert({campaign_id:null,batch_code:batchCode,candidate_id:candidate.id,candidate_name:candidate.candidate_name,candidate_email:candidate.email,cc_emails:cc.join(', '),pdf_filename:filename,subject:verification.renderedSubject,body_rendered:verification.renderedBody,status:result.success?'sent':'failed',provider:result.provider,provider_message_id:result.messageId,delivery_status:result.deliveryStatus,error_message:result.errorMessage,attempts:1,sent_at:result.success?now():null}).select('id').single();if(error)throw new Error(`Email was dispatched, but history could not be saved to Supabase: ${error.message}`);await recordActivity(req,result.success?'INDIVIDUAL_EMAIL_SENT':'INDIVIDUAL_EMAIL_FAILED','send_history',result.success?`Sent individual offer (${filename}) to ${candidate.email} via ${result.provider}`:`Failed individual offer to ${candidate.email}: ${result.errorMessage}`,history.id);if(!result.success){res.status(502).json({error:result.errorMessage||'Email delivery failed.',historyId:history.id});return;}res.json({message:`Offer email accepted by ${result.provider} for ${candidate.email}.`,batchCode,messageId:result.messageId,historyId:history.id});}));
  router.get('/campaigns',asyncRoute(async(_req,res)=>{const {data,error}=await requireSupabase().from('campaigns').select('*').order('id',{ascending:false});if(error)throw new Error(error.message);res.json({items:(data??[]).map(normalizeCampaign)});}));
  router.get('/campaigns/:id',asyncRoute(async(req,res)=>{const id=Number(req.params.id),supabase=requireSupabase();const [c,h]=await Promise.all([supabase.from('campaigns').select('*').eq('id',id).maybeSingle(),supabase.from('send_history').select('*').eq('campaign_id',id).order('id',{ascending:true})]);if(c.error||h.error)throw new Error(c.error?.message||h.error?.message);if(!c.data){res.status(404).json({error:'Campaign not found.'});return;}res.json({campaign:normalizeCampaign(c.data),deliveries:h.data});}));
  router.post('/campaigns',asyncRoute(async(req,res)=>{
    const name=String(req.body?.name||'').trim()||`Kalvi40 Offer Batch ${new Date().toLocaleDateString('en-IN')}`;
    const ids:number[]=Array.isArray(req.body?.candidateIds)?req.body.candidateIds.map(Number):[];
    const cc:string[]=Array.isArray(req.body?.ccEmails)?req.body.ccEmails.map((x:unknown)=>String(x).trim()).filter(Boolean):[];
    const skip=req.body?.skipAlreadySent!==false;
    if(!ids.length){res.status(400).json({error:'Select at least one candidate to create a campaign.'});return;}
    if(!isProviderConfigured()){res.status(400).json({error:'SMTP credentials are not configured. Configure your SMTP settings in Email Configuration before launching a bulk campaign.'});return;}
    const master=await getMasterTemplate();
    const subject=String(req.body?.subject||master.subject).trim();
    const body=String(req.body?.body||master.body).trim();
    const candidates=(await getCandidates()).filter((candidate)=>ids.includes(candidate.id));
    if(!candidates.length){res.status(404).json({error:'No matching candidates found.'});return;}
    const supabase=requireSupabase();
    const valid:Array<{candidate:Candidate;subject:string;body:string;filename:string}>=[];
    const blocked:Array<{id:number;name:string;email:string;reason:string}>=[];
    for(const candidate of candidates){
      if(skip){
        const {data:already,error}=await supabase.from('send_history').select('batch_code').eq('candidate_id',candidate.id).in('status',['sent','pending','processing']).limit(1).maybeSingle();
        if(error)throw new Error(error.message);
        if(already){blocked.push({id:candidate.id,name:candidate.candidate_name,email:candidate.email,reason:`Already sent or queued in ${already.batch_code} (duplicate prevented).`});continue;}
      }
      const verification=await verifyCandidateForSending(candidate,{ensurePdfGenerated:true,templateOverride:{subject,body}});
      if(!verification.valid)blocked.push({id:candidate.id,name:candidate.candidate_name,email:candidate.email,reason:verification.issues.join(' | ')});
      else valid.push({candidate,subject:verification.renderedSubject,body:verification.renderedBody,filename:verification.pdfFilename});
    }
    if(!valid.length){res.status(422).json({error:blocked[0]?.reason||'No valid eligible candidates to send in this batch.',blockedCandidates:blocked});return;}

    const batchCode=`BATCH-${now().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-6)}`;
    const jobs=valid.map((item)=>({
      candidate_id:item.candidate.id,
      candidate_name:item.candidate.candidate_name,
      candidate_email:item.candidate.email,
      cc_emails:cc.join(', '),
      pdf_filename:item.filename,
      subject:item.subject,
      body_rendered:item.body,
    }));
    const {data:campaignId,error:campaignError}=await supabase.rpc('kalvi40_create_campaign',{
      p_batch_code:batchCode,
      p_name:name,
      p_subject:subject,
      p_body:body,
      p_cc_emails:cc,
      p_total_count:candidates.length,
      p_valid_count:valid.length,
      p_created_by:req.admin!.email,
      p_jobs:jobs,
    });
    if(campaignError)throw new Error(`Unable to create campaign transactionally in Supabase: ${campaignError.message}`);
    const {data:campaign,error:readError}=await supabase.from('campaigns').select('*').eq('id',campaignId).single();
    if(readError)throw new Error(`Campaign was created but could not be reloaded: ${readError.message}`);
    await recordActivity(req,'CAMPAIGN_LAUNCHED','campaign',`Queued bulk campaign ${batchCode} ("${name}") with ${valid.length} emails (${blocked.length} excluded/blocked).`,campaign.id);
    triggerQueueWorker();
    res.status(202).json({campaign:normalizeCampaign(campaign),queuedCount:valid.length,blockedCount:blocked.length,blockedCandidates:blocked});
  }));

  router.get('/history',asyncRoute(async(req,res)=>{const search=String(req.query.search||'').trim().toLowerCase(),status=String(req.query.status||''),batch=String(req.query.batch||''),page=Math.max(1,Number(req.query.page||1)),pageSize=Math.min(200,Math.max(5,Number(req.query.pageSize||20)));const {data,error}=await requireSupabase().from('send_history').select('*').order('id',{ascending:false});if(error)throw new Error(error.message);let rows=data??[];if(search)rows=rows.filter((x)=>[x.candidate_name,x.candidate_email,x.batch_code,x.pdf_filename].some((v)=>String(v||'').toLowerCase().includes(search)));if(status&&status!=='all')rows=rows.filter((x)=>x.status===status);if(batch&&batch!=='all')rows=rows.filter((x)=>x.batch_code===batch);const total=rows.length;const batches=[...new Set((data??[]).map((x)=>x.batch_code))].slice(0,50);res.json({items:rows.slice((page-1)*pageSize,page*pageSize),total,page,pageSize,batches});}));
  router.post('/history/:id/retry',asyncRoute(async(req,res)=>{const id=Number(req.params.id),supabase=requireSupabase();const {data:row,error}=await supabase.from('send_history').select('*').eq('id',id).maybeSingle();if(error)throw new Error(error.message);if(!row){res.status(404).json({error:'History record not found.'});return;}if(row.status==='sent'){res.status(400).json({error:'This email was already sent.'});return;}if(!isProviderConfigured()){res.status(400).json({error:'Configure SMTP credentials before retrying.'});return;}const {error:updateError}=await supabase.from('send_history').update({status:'pending',error_message:null,delivery_status:'not_sent',updated_at:now()}).eq('id',id);if(updateError)throw new Error(updateError.message);await recordActivity(req,'EMAIL_RETRY_QUEUED','send_history',`Re-queued failed email to ${row.candidate_email} (${row.batch_code})`,id);triggerQueueWorker();res.json({message:'Email re-queued for delivery.'});}));
  router.post('/history/retry-batch',asyncRoute(async(req,res)=>{const batch=String(req.body?.batchCode||'').trim();if(!isProviderConfigured()){res.status(400).json({error:'Configure SMTP credentials before retrying.'});return;}let query=requireSupabase().from('send_history').update({status:'pending',error_message:null,delivery_status:'not_sent',updated_at:now()}).eq('status','failed');if(batch)query=query.eq('batch_code',batch);const {data,error}=await query.select('id');if(error)throw new Error(error.message);const count=data?.length??0;if(count){await recordActivity(req,'BULK_RETRY_QUEUED','send_history',`Re-queued ${count} failed email(s)${batch?` in ${batch}`:''}.`);triggerQueueWorker();}res.json({requeuedCount:count});}));
  router.post('/history/sync-delivery',(_req,res)=>res.json({checkedCount:0,updatedCount:0,message:'SMTP relay records acceptance status directly upon dispatch.'}));
  router.get('/history/export',asyncRoute(async(req,res)=>{const status=String(req.query.status||''),supabase=requireSupabase();let query=supabase.from('send_history').select('*').order('id',{ascending:false});if(status&&status!=='all')query=query.eq('status',status);const {data,error}=await query;if(error)throw new Error(error.message);const rows=(data??[]).map((h)=>({'Batch ID':h.batch_code,'Candidate Name':h.candidate_name,'Email Address':h.candidate_email,'CC Recipients':h.cc_emails,'PDF Filename':h.pdf_filename,'Queue Status':h.status,'Provider Delivery State':h.delivery_status,Provider:h.provider,'Message ID':h.provider_message_id,Attempts:h.attempts,'Sending Date':h.sent_at,'Error Message':h.error_message}));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{Notice:'No sending history available'}]),'Sending History');res.setHeader('Content-Disposition','attachment; filename="Kalvi40-Sending-History.xlsx"');res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));}));
  router.get('/logs',asyncRoute(async(req,res)=>{const search=String(req.query.search||'').trim().toLowerCase(),action=String(req.query.action||''),page=Math.max(1,Number(req.query.page||1)),pageSize=Math.min(200,Math.max(10,Number(req.query.pageSize||25)));const {data,error}=await requireSupabase().from('activity_logs').select('*').order('id',{ascending:false});if(error)throw new Error(error.message);let rows=data??[];if(search)rows=rows.filter((x)=>[x.admin_email,x.action,x.details].some((v)=>String(v||'').toLowerCase().includes(search)));if(action&&action!=='all')rows=rows.filter((x)=>x.action===action);const total=rows.length;const actions=[...new Set((data??[]).map((x)=>x.action))].sort();res.json({items:rows.slice((page-1)*pageSize,page*pageSize),total,page,pageSize,actions});}));

  router.get('/settings/general',asyncRoute(async(_req,res)=>{const {data,error}=await requireSupabase().from('system_settings').select('key,value');if(error)throw new Error(error.message);cacheSupabaseSettings(data??[]);const v=new Map((data??[]).map((x)=>[x.key,x.value]));res.json({settings:{organization_name:v.get('organization_name')||'BumbleB Trust',program_name:v.get('program_name')||'Kalvi40',contract_end_date:v.get('contract_end_date')||'30.04.2027',stipend_text:v.get('stipend_text')||'INR. 3000/- per month with effect from Oct 2026 as stipend.',trust_address:v.get('trust_address')||'No.63, 2nd Main Road, Sankarapuram, Sithalapakkam, Chennai - 600126.',trust_regn:v.get('trust_regn')||'(A Public Charitable Trust / Regn. No.125 /2019 BKIV)',trust_mobile:v.get('trust_mobile')||'+91 97910 07318',trust_email:v.get('trust_email')||'prem@bumbleb.org.in',trust_website:v.get('trust_website')||'www.bumbleb.org.in',supabase_configured:true,supabase_url:process.env.SUPABASE_URL||''}});}));
  router.put('/settings/general',asyncRoute(async(req,res)=>{const allowed=['organization_name','program_name','contract_end_date','stipend_text','trust_address','trust_regn','trust_mobile','trust_email','trust_website'];const values:Record<string,string>={};for(const key of allowed)if(req.body?.[key]!==undefined)values[key]=String(req.body[key]).trim();await saveSettings(values);await invalidateCandidatePdfs();await recordActivity(req,'GENERAL_SETTINGS_UPDATED','settings','Updated general organization and offer letter letterhead configuration.');res.json({message:'General settings saved.'});}));
  router.get('/settings/signature',(_req,res)=>res.json({signature:getFounderSignatureInfo()}));
  router.post('/settings/signature',asyncRoute(async(req,res)=>{const raw=typeof req.body?.imageDataUrl==='string'?req.body.imageDataUrl.trim():'';const m=raw.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);if(!m){res.status(400).json({error:'Invalid signature image format. Please upload a valid PNG or JPG image.'});return;}const buffer=Buffer.from(m[2].replace(/\s+/g,''),'base64');if(buffer.length<32||buffer.length>5*1024*1024){res.status(400).json({error:'Signature image must be valid and 5 MB or smaller.'});return;}const png=buffer[0]===0x89&&buffer[1]===0x50&&buffer[2]===0x4e&&buffer[3]===0x47,jpg=buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;if(!png&&!jpg){res.status(400).json({error:'Uploaded file is not a valid PNG or JPEG image.'});return;}const filename=`founder_signature.${png?'png':'jpg'}`;fs.writeFileSync(path.join(uploadsStorageDir,filename),buffer);const values:Record<string,string>={founder_signature_filename:filename,founder_signature_mime:png?'image/png':'image/jpeg',founder_signature_updated_at:now()};if(req.body?.heightPt!==undefined)values.founder_signature_height=String(Math.max(24,Math.min(72,Math.round(Number(req.body.heightPt)||40))));await saveSettings(values);await invalidateCandidatePdfs();await recordActivity(req,'FOUNDER_SIGNATURE_UPLOADED','settings',`Uploaded custom Founder signature (${filename}, ${(buffer.length/1024).toFixed(1)} KB).`);res.json({message:'Founder signature uploaded successfully.',signature:getFounderSignatureInfo()});}));
  router.put('/settings/signature/options',asyncRoute(async(req,res)=>{const height=Math.max(24,Math.min(72,Math.round(Number(req.body?.heightPt)||40)));await saveSettings({founder_signature_height:String(height),founder_signature_updated_at:now()});await invalidateCandidatePdfs();await recordActivity(req,'FOUNDER_SIGNATURE_RESIZED','settings',`Updated Founder signature height to ${height} pt.`);res.json({message:'Founder signature size updated.',signature:getFounderSignatureInfo()});}));
  router.delete('/settings/signature',asyncRoute(async(req,res)=>{for(const name of [getSetting('founder_signature_filename',''),'founder_signature.png','founder_signature.jpg']){const file=safeFilename(name);if(file)try{fs.unlinkSync(path.join(uploadsStorageDir,file));}catch{/* local cleanup */}}await saveSettings({founder_signature_filename:'',founder_signature_mime:'',founder_signature_updated_at:''});await invalidateCandidatePdfs();await recordActivity(req,'FOUNDER_SIGNATURE_REMOVED','settings','Removed uploaded Founder signature and restored default signature.');res.json({message:'Founder signature reset to default.',signature:getFounderSignatureInfo()});}));

  router.get('/settings/email', asyncRoute(async (_req, res) => {
    const { data, error } = await requireSupabase().from('system_settings').select('key,value');
    if (error) throw new Error(error.message);
    cacheSupabaseSettings(data ?? []);
    res.json({ config: getPublicEmailConfig() });
  }));
  router.put('/settings/email', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const host = typeof body.smtp_host === 'string' ? body.smtp_host.trim() : getSetting('smtp_host', 'smtp.gmail.com');
    if (typeof body.smtp_host === 'string' && !isValidSmtpHost(host)) {
      res.status(400).json({ error: `Invalid SMTP Host "${host}". Enter a mail server hostname such as smtp.gmail.com, not an email address.` }); return;
    }
    const values: Record<string, string> = { email_provider: 'smtp' };
    for (const key of ['sender_name', 'sender_email', 'reply_to', 'smtp_user']) if (typeof body[key] === 'string') values[key] = body[key].trim();
    if (typeof body.smtp_host === 'string') values.smtp_host = host;
    if (body.smtp_port !== undefined) values.smtp_port = String(Math.max(1, Math.min(65535, Number(body.smtp_port) || 587)));
    if (body.smtp_secure !== undefined) values.smtp_secure = body.smtp_secure ? 'true' : 'false';
    if (body.rate_limit_per_minute !== undefined) values.rate_limit_per_minute = String(Math.max(1, Math.min(300, Number(body.rate_limit_per_minute) || 45)));
    if (body.max_retries !== undefined) values.max_retries = String(Math.max(0, Math.min(5, Number(body.max_retries) || 3)));
    if (typeof body.smtp_pass === 'string' && body.smtp_pass.trim() && !body.smtp_pass.includes('••••')) setRuntimeSecret('smtp_pass', normalizeSmtpPassword(host, body.smtp_pass));
    await saveSettings(values);
    await recordActivity(req, 'EMAIL_CONFIG_UPDATED', 'settings', `Updated SMTP configuration (${getSetting('smtp_host')}:${getSetting('smtp_port')}, sender: ${getSetting('sender_email')})`);
    res.json({ config: getPublicEmailConfig() });
  }));
  router.post('/settings/email/test-connection', asyncRoute(async (req, res) => {
    const result = await verifyEmailProviderConnection();
    await recordActivity(req, 'EMAIL_CONNECTION_TEST', 'settings', result.ok ? `Verified ${result.provider} connection: ${result.accountInfo}` : `Connection test failed (${result.provider}): ${result.error}`);
    res.status(result.ok ? 200 : 400).json(result);
  }));
  router.post('/settings/email/send-test', asyncRoute(async (req, res) => {
    const email = String(req.body?.toEmail || '').trim().toLowerCase();
    if (!validEmail(email)) { res.status(400).json({ error: 'Provide a valid recipient email address for the test email.' }); return; }
    const candidate = (await getCandidates())[0]; const template = await getMasterTemplate();
    const bodyText = candidate ? renderTemplateString(template.body, candidate) : 'Kalvi40 email provider verification test message.';
    let attachmentBuffer: Buffer = Buffer.from('Test attachment'); let attachmentFilename = 'Kalvi40_Test_Offer.pdf';
    if (candidate) { const pdf = await generateOfferLetterPdf(candidate); attachmentBuffer = Buffer.from(pdf.buffer); attachmentFilename = pdf.filename; }
    const result = await sendTransactionalOfferEmail({ toEmail: email, toName: 'Kalvi40 Administrator Test', ccEmails: [], subject: `[Test] ${template.subject}`, bodyText, attachmentFilename, attachmentBuffer });
    if (!result.success) { res.status(400).json({ error: result.errorMessage || 'Test email delivery failed.' }); return; }
    res.json({ message: `Test email with PDF attachment accepted by ${result.provider} (Message ID: ${result.messageId || 'N/A'}).`, messageId: result.messageId });
  }));
  router.get('/import/sample-excel', (_req, res) => {
    const rows = [
      { 'Candidate Name': 'Sample Candidate One', 'School Name': 'Sample Government Middle School', Location: 'Sample Town', District: 'Tiruvannamalai', 'Mobile Number': '9000000001', Email: 'candidate1@example.org', 'Joining Date': '21.10.2026' },
      { 'Candidate Name': 'Sample Candidate Two', 'School Name': 'Sample Girls Higher Secondary School', Location: 'Sample City', District: 'Chengalpattu', 'Mobile Number': '9000000002', Email: 'candidate2@example.org', 'Joining Date': '01.11.2026' },
    ];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Candidates');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Kalvi40_Candidate_Import_Template.xlsx"');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { if (!res.headersSent) sendError(res, error); });
  return router;
}
