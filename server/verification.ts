import fs from 'node:fs';
import path from 'node:path';
import { db, pdfStorageDir } from './db.ts';
import {
  extractTextFromPdfBuffer,
  generateOfferLetterPdf,
  getOfferLetterTemplate,
  sanitizeForPdfWinAnsi,
} from './pdfGenerator.ts';
import {
  formatDateDDMMYYYY,
  normalizeSchoolName,
  renderTemplateString,
  sanitizeOfferFilename,
  type Candidate,
  type CandidateVerificationResult,
  type EmailTemplate,
  type VerificationCheckItem,
} from '../src/types/kalvi40.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNRESOLVED_PLACEHOLDER_REGEX = /\{\{[^}]+\}\}/g;

function normalizeForPdfMatch(text: string): string {
  return sanitizeForPdfWinAnsi(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function getMasterTemplate(): EmailTemplate {
  const row = db.prepare('SELECT * FROM email_templates WHERE is_master = 1 ORDER BY id DESC LIMIT 1').get() as EmailTemplate | undefined;
  if (!row) {
    throw new Error('Master email template is missing from the database.');
  }
  return row;
}

export async function verifyCandidateForSending(
  candidate: Candidate,
  options: { ensurePdfGenerated?: boolean; templateOverride?: { subject: string; body: string } } = {}
): Promise<CandidateVerificationResult> {
  const master = options.templateOverride ?? getMasterTemplate();
  const offerTemplate = getOfferLetterTemplate();
  const renderedSubject = renderTemplateString(master.subject, candidate, {
    contract_end_date: offerTemplate.contract_end_date,
    stipend_text: offerTemplate.stipend_text,
  });
  const renderedBody = renderTemplateString(master.body, candidate, {
    contract_end_date: offerTemplate.contract_end_date,
    stipend_text: offerTemplate.stipend_text,
  });
  const expectedFilename = sanitizeOfferFilename(candidate.candidate_name);
  const filePath = path.join(pdfStorageDir, expectedFilename);

  let pdfBuffer: Buffer | null = null;
  if (options.ensurePdfGenerated || !fs.existsSync(filePath)) {
    const generated = await generateOfferLetterPdf(candidate);
    pdfBuffer = generated.buffer;
  } else {
    pdfBuffer = fs.readFileSync(filePath);
  }

  const pdfExists = Boolean(pdfBuffer && pdfBuffer.length > 500);
  const extractedPdfText = pdfBuffer ? extractTextFromPdfBuffer(pdfBuffer) : '';
  const normalizedPdfText = normalizeForPdfMatch(extractedPdfText);

  const formattedDate = formatDateDDMMYYYY(candidate.joining_date);
  const checks: VerificationCheckItem[] = [];

  // 1. Required fields check
  const missingFields: string[] = [];
  if (!candidate.candidate_name?.trim()) missingFields.push('Candidate Name');
  if (!candidate.school_name?.trim()) missingFields.push('School Name');
  if (!candidate.location?.trim()) missingFields.push('Location');
  if (!candidate.district?.trim()) missingFields.push('District');
  if (!candidate.joining_date?.trim()) missingFields.push('Joining Date');

  checks.push({
    key: 'required_fields',
    label: 'Candidate Profile Completeness',
    passed: missingFields.length === 0,
    message:
      missingFields.length === 0
        ? 'All 6 required candidate fields are populated.'
        : `Missing required fields: ${missingFields.join(', ')}.`,
  });

  // 2. Valid email format
  const emailValid = EMAIL_REGEX.test((candidate.email || '').trim());
  checks.push({
    key: 'email_format',
    label: 'Valid Recipient Email',
    passed: emailValid,
    expected: 'valid@domain.tld',
    actual: candidate.email,
    message: emailValid ? `Email "${candidate.email}" is syntactically valid.` : `Invalid email address "${candidate.email}".`,
  });

  // 3. Unresolved placeholders in rendered subject, email body, and PDF
  const unresolvedInSubject = renderedSubject.match(UNRESOLVED_PLACEHOLDER_REGEX) || [];
  const unresolvedInBody = renderedBody.match(UNRESOLVED_PLACEHOLDER_REGEX) || [];
  const unresolvedInPdf = extractedPdfText.match(UNRESOLVED_PLACEHOLDER_REGEX) || [];
  const allUnresolved = Array.from(new Set([...unresolvedInSubject, ...unresolvedInBody, ...unresolvedInPdf]));
  checks.push({
    key: 'no_unresolved_placeholders',
    label: 'Template Placeholder Resolution',
    passed: allUnresolved.length === 0,
    message:
      allUnresolved.length === 0
        ? 'Zero unresolved template placeholders detected across email & PDF.'
        : `Unresolved placeholders found: ${allUnresolved.join(', ')}.`,
  });

  // 4. Candidate Name Consistency: DB vs Email vs PDF
  const dbName = (candidate.candidate_name || '').trim();
  const nameInEmail = dbName.length > 0 && renderedBody.toLowerCase().includes(dbName.toLowerCase());
  const nameInPdf = dbName.length > 0 && normalizedPdfText.includes(normalizeForPdfMatch(dbName));

  checks.push({
    key: 'name_match_email',
    label: 'Name Match: Database vs Email Body',
    passed: nameInEmail,
    expected: dbName,
    actual: nameInEmail ? dbName : 'Not found in email body',
    message: nameInEmail
      ? `Email body addresses "${dbName}".`
      : `Candidate name "${dbName}" was not found in the rendered email body.`,
  });

  checks.push({
    key: 'name_match_pdf',
    label: 'Name Match: Database vs Generated PDF',
    passed: pdfExists && nameInPdf,
    expected: dbName,
    actual: nameInPdf ? dbName : 'Not found in PDF stream',
    message:
      pdfExists && nameInPdf
        ? `PDF content verified to contain "${dbName}".`
        : `Candidate name "${dbName}" could not be verified inside ${expectedFilename}.`,
  });

  // 5. School, Location, District & Joining Date inside PDF (handles arbitrary school formats & custom offer text)
  const activeOfferBody =
    candidate.custom_offer_body && candidate.custom_offer_body.trim()
      ? candidate.custom_offer_body
      : offerTemplate.body;
  const expectsSchoolInBody = /\{\{\s*school_name\s*\}\}/i.test(activeOfferBody);
  const schoolNorm = normalizeForPdfMatch(normalizeSchoolName(candidate.school_name || ''));
  const schoolInPdf = !expectsSchoolInBody || (Boolean(schoolNorm) && normalizedPdfText.includes(schoolNorm));
  const locationInPdf = Boolean(candidate.location?.trim()) && normalizedPdfText.includes(normalizeForPdfMatch(candidate.location));
  const districtInPdf = Boolean(candidate.district?.trim()) && normalizedPdfText.includes(normalizeForPdfMatch(candidate.district));
  const dateInPdf = Boolean(formattedDate) && normalizedPdfText.includes(normalizeForPdfMatch(formattedDate));

  checks.push({
    key: 'placement_match_pdf',
    label: 'School, Location, District & Date in PDF',
    passed: schoolInPdf && locationInPdf && districtInPdf && dateInPdf,
    message:
      schoolInPdf && locationInPdf && districtInPdf && dateInPdf
        ? `School, location, district, and joining date (${formattedDate}) verified inside PDF.`
        : `PDF content mismatch: ${[
            !schoolInPdf && 'School Name',
            !locationInPdf && 'Location',
            !districtInPdf && 'District',
            !dateInPdf && 'Joining Date',
          ]
            .filter(Boolean)
            .join(', ')} not matched.`,
  });

  // 6. PDF File Readiness & Filename check
  checks.push({
    key: 'pdf_ready',
    label: 'Offer Letter PDF Attachment Ready',
    passed: pdfExists,
    expected: expectedFilename,
    actual: pdfExists ? `${expectedFilename} (${Math.round((pdfBuffer?.length || 0) / 1024)} KB)` : 'Missing',
    message: pdfExists
      ? `Attachment ${expectedFilename} is generated and ready.`
      : `Offer letter PDF ${expectedFilename} has not been generated.`,
  });

  const issues = checks.filter((c) => !c.passed).map((c) => c.message);
  const valid = issues.length === 0;

  db.prepare(`
    UPDATE candidates
    SET verification_status = ?,
        verification_issues = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(valid ? 'verified' : 'failed', valid ? null : JSON.stringify(issues), candidate.id);

  return {
    candidateId: candidate.id,
    valid,
    pdfFilename: expectedFilename,
    pdfExists,
    renderedSubject,
    renderedBody,
    checks,
    issues,
  };
}
