export type DeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed';
export type ProviderDeliveryState = 'not_sent' | 'accepted' | 'delivered' | 'bounced' | 'failed';

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string;
  designation: string;
  phone: string;
  last_login_at: string | null;
  created_at: string;
}

export interface Candidate {
  id: number;
  candidate_name: string;
  school_name: string;
  location: string;
  district: string;
  phone: string;
  email: string;
  joining_date: string;
  offer_generated: number;
  offer_generated_at: string | null;
  offer_filename: string | null;
  verification_status: 'unverified' | 'verified' | 'failed';
  verification_issues: string | null;
  custom_offer_body?: string | null;
  last_send_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  is_master: number;
  updated_by: string | null;
  updated_at: string;
}

export interface CcRecipient {
  id: number;
  email: string;
  label: string;
  enabled: number;
  is_default: number;
  created_at: string;
}

export interface Campaign {
  id: number;
  batch_code: string;
  name: string;
  subject: string;
  body: string;
  cc_emails_json: string;
  total_count: number;
  valid_count: number;
  sent_count: number;
  failed_count: number;
  pending_count: number;
  status: 'queued' | 'processing' | 'completed' | 'completed_with_errors' | 'paused';
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export interface SendHistoryRecord {
  id: number;
  campaign_id: number | null;
  batch_code: string;
  candidate_id: number;
  candidate_name: string;
  candidate_email: string;
  cc_emails: string;
  pdf_filename: string;
  subject: string;
  status: DeliveryStatus;
  provider: string;
  provider_message_id: string | null;
  delivery_status: ProviderDeliveryState;
  error_message: string | null;
  attempts: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: number;
  admin_id: number | null;
  admin_email: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string;
  ip_address: string | null;
  created_at: string;
}

export interface VerificationCheckItem {
  key: string;
  label: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  message: string;
}

export interface CandidateVerificationResult {
  candidateId: number;
  valid: boolean;
  pdfFilename: string;
  pdfExists: boolean;
  renderedSubject: string;
  renderedBody: string;
  checks: VerificationCheckItem[];
  issues: string[];
}

export interface EmailConfigPublic {
  email_provider: 'smtp';
  sender_name: string;
  sender_email: string;
  reply_to: string;
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_pass_set: boolean;
  smtp_secure: boolean;
  rate_limit_per_minute: number;
  max_retries: number;
  provider_configured: boolean;
}

export interface OfferLetterTemplate {
  header_name: string;
  header_role: string;
  brand_title: string;
  brand_subtitle: string;
  trust_regn: string;
  trust_address: string;
  trust_mobile: string;
  trust_email: string;
  trust_website: string;
  heading: string;
  greeting: string;
  body: string;
  closing: string;
  signatory_title: string;
  signatory_org: string;
  contract_end_date: string;
  stipend_text: string;
  footer_left_url: string;
  footer_right_url: string;
  body_font_size: number;
}

export interface FounderSignatureInfo {
  hasCustomSignature: boolean;
  heightPt: number;
  updatedAt: string | null;
  dataUrl: string | null;
}

export interface GeneralSettings {
  organization_name: string;
  program_name: string;
  contract_end_date: string;
  stipend_text: string;
  trust_address: string;
  trust_regn: string;
  trust_mobile: string;
  trust_email: string;
  trust_website: string;
  supabase_configured: boolean;
  supabase_url: string;
}

export const DEFAULT_MASTER_SUBJECT = 'Congratulations on Your Appointment – Teaching Coordinator';

export const DEFAULT_MASTER_BODY = `Dear {{candidate_name}},

Greetings from BumbleB Trust - Kalvi40.

Congratulations on your appointment as the Teaching Coordinator at {{school_name}}, {{location}}, {{district}}.

Please find your offer letter attached. The physical copy and your welcome kit are being prepared and will be sent to you shortly.

We look forward to your contributions to the team. In the meantime, we encourage you to install the Kalvi40 app on your Android device and follow our social media pages.

We wish you all the best in your new role.

Best regards,

S. Sankareswari
Coordinator, Accounts & Admin`;

export const TEMPLATE_PLACEHOLDERS = [
  { key: '{{candidate_name}}', label: 'Candidate Name' },
  { key: '{{school_name}}', label: 'School Name' },
  { key: '{{location}}', label: 'Location' },
  { key: '{{district}}', label: 'District' },
  { key: '{{email}}', label: 'Email Address' },
  { key: '{{joining_date}}', label: 'Joining Date' },
] as const;

export function sanitizeOfferFilename(candidateName: string): string {
  const cleaned = candidateName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `Offer_Letter_${cleaned || 'Candidate'}.pdf`;
}

export function formatDateDDMMYYYY(rawDate: string): string {
  const trimmed = (rawDate || '').trim();
  if (!trimmed) return '';
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) return trimmed;
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`;
  const slashMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashMatch) {
    const d = slashMatch[1].padStart(2, '0');
    const m = slashMatch[2].padStart(2, '0');
    return `${d}.${m}.${slashMatch[3]}`;
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const d = String(parsed.getDate()).padStart(2, '0');
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const y = parsed.getFullYear();
    return `${d}.${m}.${y}`;
  }
  return trimmed;
}

export const DEFAULT_OFFER_LETTER_BODY = `With utmost happiness, we, the Kalvi40 Team, would like to place you on contract as our **TEACHING COORDINATOR** for the period from **{{joining_date}}** to **{{contract_end_date}}.**

In your capacity as a Teaching Coordinator, you are expected to coordinate with the Management of **{{school_name}}, {{location}}, {{district_label}}.** You are expected to put in your best efforts and active participation in all of our activities is encouraged and will be monitored closely. Your behavior is expected to be professional and required to maintain utmost discretion with respect to our Trusts' activities. You shall not indulge in any activities that may deter our progress or damage our reputation.

You would be compensated with **{{stipend_text}}** You will also be given an incentive in April 2027 depending on your performance.

Should you choose to discontinue the contract before the stipulated time, you are required to communicate the same via email with a months' notice period. The Trust has the rights to terminate you at any point of the contract period in case of any adverse happening. In the event of yourself getting relieved from the contract, you are expected to surrender the Kalvi40 ID Card to the BumbleB Office.

You shall be given an Experience Certificate at the end of the tenure. If you wish to accept our offer, kindly communicate through email.`;

export const DEFAULT_OFFER_LETTER_TEMPLATE: OfferLetterTemplate = {
  header_name: 'Prem Kumar Gokuladasan, B.E., M.B.A.,',
  header_role: 'Managing Trustee',
  brand_title: 'BumbleB',
  brand_subtitle: 'T R U S T',
  trust_regn: '(A Public Charitable Trust / Regn. No.125 /2019 BKIV)',
  trust_address: 'No.63, 2nd Main Road, Sankarapuram, Sithalapakkam, Chennai - 600126.',
  trust_mobile: '+91 97910 07318',
  trust_email: 'prem@bumbleb.org.in',
  trust_website: 'www.bumbleb.org.in',
  heading: 'ENGAGEMENT LETTER',
  greeting: 'Greetings from BumbleB Trust - Kalvi40!!',
  body: DEFAULT_OFFER_LETTER_BODY,
  closing: 'With regards,',
  signatory_title: 'Founder & Managing Trustee',
  signatory_org: 'BumbleB Trust, Chennai',
  contract_end_date: '30.04.2027',
  stipend_text: 'INR. 3000/- per month with effect from Oct 2026 as stipend.',
  footer_left_url: 'www.bumbleb.org.in',
  footer_right_url: 'www.kalvi40.com',
  body_font_size: 10.5,
};

export const OFFER_TEMPLATE_PLACEHOLDERS = [
  { key: '{{candidate_name}}', label: 'Candidate Name' },
  { key: '{{school_name}}', label: 'School Name' },
  { key: '{{location}}', label: 'Location' },
  { key: '{{district}}', label: 'District' },
  { key: '{{district_label}}', label: 'District + "District"' },
  { key: '{{email}}', label: 'Email Address' },
  { key: '{{joining_date}}', label: 'Joining Date' },
  { key: '{{contract_end_date}}', label: 'Contract End Date' },
  { key: '{{stipend_text}}', label: 'Stipend Clause' },
] as const;

export function formatDistrictLabel(district: string): string {
  const trimmed = (district || '').trim();
  if (!trimmed) return 'District';
  return /district$/i.test(trimmed) ? trimmed : `${trimmed} District`;
}

export function normalizeSchoolName(raw: string): string {
  return (raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderTemplateString(
  template: string,
  candidate: Pick<Candidate, 'candidate_name' | 'school_name' | 'location' | 'district' | 'email' | 'joining_date'>,
  extra?: { contract_end_date?: string; stipend_text?: string }
): string {
  const formattedDate = formatDateDDMMYYYY(candidate.joining_date);
  const schoolClean = normalizeSchoolName(candidate.school_name || '');
  const districtLabel = formatDistrictLabel(candidate.district || '');
  return template
    .replace(/\{\{\s*candidate_name\s*\}\}/gi, candidate.candidate_name || '')
    .replace(/\{\{\s*school_name\s*\}\}/gi, schoolClean)
    .replace(/\{\{\s*location\s*\}\}/gi, candidate.location || '')
    .replace(/\{\{\s*district_label\s*\}\}/gi, districtLabel)
    .replace(/\{\{\s*district\s*\}\}/gi, candidate.district || '')
    .replace(/\{\{\s*email\s*\}\}/gi, candidate.email || '')
    .replace(/\{\{\s*joining_date\s*\}\}/gi, formattedDate || '')
    .replace(/\{\{\s*contract_end_date\s*\}\}/gi, extra?.contract_end_date || DEFAULT_OFFER_LETTER_TEMPLATE.contract_end_date)
    .replace(/\{\{\s*stipend_text\s*\}\}/gi, extra?.stipend_text || DEFAULT_OFFER_LETTER_TEMPLATE.stipend_text);
}
