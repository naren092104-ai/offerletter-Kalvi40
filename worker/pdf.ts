import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { formatDateDDMMYYYY, normalizeSchoolName, sanitizeOfferFilename, type OfferLetterTemplate } from '../src/types/kalvi40.ts';

const ink = rgb(0.11, 0.14, 0.2);
const navy = rgb(0.063, 0.141, 0.227);
const blue = rgb(0.21, 0.36, 0.62);
const orange = rgb(0.93, 0.29, 0.16);

function sanitizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u20B9/g, 'INR ')
    .replace(/\u2022/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x0A\x0D\x20-\x7E\xA0-\xFF]/g, ' ');
}

function fillTemplate(text: string, candidate: Record<string, unknown>, template: OfferLetterTemplate): string {
  const schoolName = normalizeSchoolName(String(candidate.school_name ?? ''));
  const replacements: Record<string, string> = {
    candidate_name: String(candidate.candidate_name ?? ''),
    school_name: schoolName,
    location: String(candidate.location ?? ''),
    district: String(candidate.district ?? ''),
    district_label: /district$/i.test(String(candidate.district ?? '')) ? String(candidate.district ?? '') : `${String(candidate.district ?? '')} District`,
    email: String(candidate.email ?? ''),
    joining_date: formatDateDDMMYYYY(String(candidate.joining_date ?? '')),
    contract_end_date: template.contract_end_date,
    stipend_text: template.stipend_text,
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => replacements[key.toLowerCase()] ?? `{{${key}}}`);
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawFooter(page: PDFPage, width: number, template: OfferLetterTemplate, font: Awaited<ReturnType<PDFDocument['embedFont']>>): void {
  const left = sanitizeText(template.footer_left_url);
  const right = sanitizeText(template.footer_right_url);
  const footer = [left, right].filter(Boolean).join(' | ');
  if (footer) page.drawText(footer, { x: 64, y: 42, size: 9, font, color: blue });
  page.drawLine({ start: { x: 64, y: 58 }, end: { x: width - 64, y: 58 }, thickness: 0.5, color: blue });
}

export async function buildOfferLetterPdfBuffer(
  candidate: Record<string, unknown>,
  template: OfferLetterTemplate,
  signature?: { bytes: Uint8Array; mime: string; heightPt: number } | null,
  logo?: Uint8Array | null,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const filename = sanitizeOfferFilename(String(candidate.candidate_name ?? 'Candidate'));
  const candidateName = sanitizeText(candidate.candidate_name);
  const school = sanitizeText(normalizeSchoolName(String(candidate.school_name ?? '')));
  const location = sanitizeText(candidate.location);
  const district = sanitizeText(candidate.district);
  const email = sanitizeText(candidate.email);
  const joiningDate = sanitizeText(formatDateDDMMYYYY(String(candidate.joining_date ?? '')));
  const width = 595.28;
  const height = 841.89;
  const margin = 64;
  const contentWidth = width - margin * 2;
  const title = sanitizeText(template.heading || 'ENGAGEMENT LETTER');
  const paragraphs = fillTemplate(
    typeof candidate.custom_offer_body === 'string' && candidate.custom_offer_body.trim() ? candidate.custom_offer_body : template.body,
    candidate,
    template,
  ).replace(/\*\*/g, '');
  const bodySize = Math.max(9, Math.min(12.5, Number(template.body_font_size) || 10.5));
  let page = pdf.addPage([width, height]);
  let y = 785;

  let logoImage: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null;
  if (logo) {
    try {
      logoImage = await pdf.embedPng(logo);
    } catch {
      logoImage = null;
    }
  }

  const drawHeader = (target: PDFPage) => {
    target.drawText(sanitizeText(template.header_name), { x: margin, y: 785, size: 9, font: bold, color: ink });
    target.drawText(sanitizeText(template.header_role), { x: margin, y: 771, size: 10, font: italic, color: ink });
    target.drawText(sanitizeText(template.trust_mobile), { x: 368, y: 785, size: 8, font: regular, color: ink });
    target.drawText(sanitizeText(template.trust_email), { x: 368, y: 773, size: 8, font: regular, color: ink });
    target.drawText(sanitizeText(template.trust_website), { x: 368, y: 761, size: 8, font: regular, color: ink });
    const brand = sanitizeText(template.brand_title || 'BumbleB');
    target.drawText(brand, { x: (width - bold.widthOfTextAtSize(brand, 22)) / 2, y: 744, size: 22, font: bold, color: navy });
    const subtitle = sanitizeText(template.brand_subtitle);
    if (subtitle && !logoImage) target.drawText(subtitle, { x: (width - bold.widthOfTextAtSize(subtitle, 8)) / 2, y: 730, size: 8, font: bold, color: navy });
    const regn = sanitizeText(template.trust_regn);
    if (regn) target.drawText(regn, { x: (width - regular.widthOfTextAtSize(regn, 9)) / 2, y: 707, size: 9, font: regular, color: ink });
    const address = sanitizeText(template.trust_address);
    if (address) target.drawText(address.slice(0, 110), { x: (width - regular.widthOfTextAtSize(address.slice(0, 110), 9)) / 2, y: 693, size: 9, font: regular, color: navy });
    target.drawLine({ start: { x: 60, y: 684 }, end: { x: width - 60, y: 684 }, thickness: 1, color: blue });
    if (logoImage) {
      const logoSize = logoImage.scaleToFit(92, 92);
      target.drawImage(logoImage, {
        x: (width - logoSize.width) / 2,
        y: 675,
        width: logoSize.width,
        height: logoSize.height,
      });
    } else {
      const brand = sanitizeText(template.brand_title || 'BumbleB');
      target.drawText(brand, { x: (width - bold.widthOfTextAtSize(brand, 22)) / 2, y: 744, size: 22, font: bold, color: navy });
    }
  };
  drawHeader(page);
  page.drawText(title, { x: (width - bold.widthOfTextAtSize(title, 11.5)) / 2, y: 659, size: 11.5, font: bold, color: ink });
  page.drawLine({ start: { x: 170, y: 657 }, end: { x: width - 170, y: 657 }, thickness: 0.5, color: ink });
  y = 628;
  page.drawText(`Dear ${candidateName},`, { x: margin, y, size: 10.5, font: bold, color: ink });
  page.drawText(`${location}, ${district}`, { x: margin, y: y - 14, size: 9.5, font: regular, color: ink });
  page.drawText(`Email ID: ${email}`, { x: margin, y: y - 27, size: 9.5, font: regular, color: ink });
  page.drawText(joiningDate, { x: width - margin - regular.widthOfTextAtSize(joiningDate, 9.5), y, size: 9.5, font: regular, color: ink });
  y -= 56;
  const greeting = sanitizeText(template.greeting);
  if (greeting) {
    page.drawText(greeting, { x: margin, y, size: 10.5, font: bold, color: ink });
    y -= 22;
  }
  const drawParagraphLines = (target: PDFPage, lines: string[], startY: number) => {
    let cursor = startY;
    for (const line of lines) {
      if (cursor < 105) {
        drawFooter(target, width, template, regular);
        target = pdf.addPage([width, height]);
        drawHeader(target);
        cursor = 650;
      }
      if (line) target.drawText(line, { x: margin, y: cursor, size: bodySize, font: regular, color: ink });
      cursor -= bodySize * 1.45;
    }
    return { page: target, y: cursor };
  };
  const lines = wrapText(paragraphs, regular, bodySize, contentWidth);
  ({ page, y } = drawParagraphLines(page, lines, y));
  y -= 10;
  for (const text of [template.closing, template.signatory_title, template.signatory_org]) {
    const line = sanitizeText(text);
    if (!line) continue;
    if (y < 110) {
      drawFooter(page, width, template, regular);
      page = pdf.addPage([width, height]);
      drawHeader(page);
      y = 650;
    }
    page.drawText(line, { x: margin, y, size: 10, font: line === template.signatory_title ? bold : regular, color: ink });
    y -= 15;
    if (text === template.closing && signature) {
      try {
        const image = signature.mime === 'image/png' ? await pdf.embedPng(signature.bytes) : await pdf.embedJpg(signature.bytes);
        const dimensions = image.scaleToFit(190, signature.heightPt);
        if (y < 110) {
          drawFooter(page, width, template, regular);
          page = pdf.addPage([width, height]);
          drawHeader(page);
          y = 650;
        }
        page.drawImage(image, { x: margin, y: y - dimensions.height + 2, width: dimensions.width, height: dimensions.height });
        y -= dimensions.height + 4;
      } catch {
        // An invalid or unsupported signature should not prevent PDF generation.
      }
    }
  }
  drawFooter(page, width, template, regular);
  pdf.setTitle(`Engagement Letter - ${candidateName}`);
  pdf.setAuthor('BumbleB Trust - Kalvi40');
  pdf.setSubject(`Teaching Coordinator Engagement Letter | ${school} | ${district}`);
  pdf.setKeywords([candidateName, school, location, district, email, joiningDate]);
  return { bytes: await pdf.save({ useObjectStreams: false }), filename };
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  const chunks: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    let stream = match[1];
    const beforeStream = raw.slice(Math.max(0, match.index - 300), match.index);
    if (/\/FlateDecode/.test(beforeStream)) {
      try {
        const source = Uint8Array.from(stream, (char) => char.charCodeAt(0));
        const decompressed = await new Response(new Blob([source]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        stream = String.fromCharCode(...new Uint8Array(decompressed));
      } catch {
        continue;
      }
    }
    const literalRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let literal: RegExpExecArray | null;
    while ((literal = literalRegex.exec(stream)) !== null) {
      const text = literal[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, ' ').replace(/\\r/g, ' ');
      if (text.trim()) chunks.push(text);
    }
    const hexRegex = /<([0-9A-Fa-f\s]+)>/g;
    let hex: RegExpExecArray | null;
    while ((hex = hexRegex.exec(stream)) !== null) {
      const clean = hex[1].replace(/\s+/g, '');
      if (clean.length >= 2 && clean.length % 2 === 0) {
        let decoded = '';
        for (let index = 0; index < clean.length; index += 2) decoded += String.fromCharCode(parseInt(clean.slice(index, index + 2), 16));
        if (/^[\x20-\x7E]+$/.test(decoded)) chunks.push(decoded);
      }
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}
