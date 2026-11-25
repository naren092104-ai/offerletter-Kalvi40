import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { formatDateDDMMYYYY, normalizeSchoolName, sanitizeOfferFilename, type OfferLetterTemplate } from '../src/types/kalvi40.ts';

const ink = rgb(0.11, 0.14, 0.2);
const navy = rgb(0.063, 0.141, 0.227);
const blue = rgb(0.21, 0.36, 0.62);
const linkBlue = rgb(0.114, 0.306, 0.686);
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

function drawFooter(page: PDFPage, width: number, template: OfferLetterTemplate, font: Awaited<ReturnType<PDFDocument['embedFont']>>, logoImage: Awaited<ReturnType<PDFDocument['embedPng']>> | null): void {
  const left = sanitizeText(template.footer_left_url);
  const right = sanitizeText(template.footer_right_url);
  const separator = left && right ? ' | ' : '';
  const totalWidth = (left ? font.widthOfTextAtSize(left, 8.5) : 0)
    + (separator ? font.widthOfTextAtSize(separator, 8.5) : 0)
    + (right ? font.widthOfTextAtSize(right, 8.5) : 0);
  const margin = 64;
  let cursorX = width - margin - totalWidth;
  const footerY = 50;

  if (logoImage) {
    const logoSize = logoImage.scaleToFit(46, 46);
    page.drawImage(logoImage, { x: margin - 2, y: 38, width: logoSize.width, height: logoSize.height });
  }

  if (left) {
    page.drawText(left, { x: cursorX, y: footerY, size: 8.5, font, color: linkBlue });
    const leftWidth = font.widthOfTextAtSize(left, 8.5);
    page.drawLine({ start: { x: cursorX, y: footerY - 1.2 }, end: { x: cursorX + leftWidth, y: footerY - 1.2 }, thickness: 0.5, color: linkBlue });
    cursorX += leftWidth;
  }
  if (separator) {
    page.drawText(separator, { x: cursorX, y: footerY, size: 8.5, font, color: ink });
    cursorX += font.widthOfTextAtSize(separator, 8.5);
  }
  if (right) {
    page.drawText(right, { x: cursorX, y: footerY, size: 8.5, font, color: linkBlue });
    const rightWidth = font.widthOfTextAtSize(right, 8.5);
    page.drawLine({ start: { x: cursorX, y: footerY - 1.2 }, end: { x: cursorX + rightWidth, y: footerY - 1.2 }, thickness: 0.5, color: linkBlue });
  }
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
    target.drawText('Mobile', { x: 368, y: 787, size: 9, font: regular, color: ink });
    target.drawText(`: ${sanitizeText(template.trust_mobile)}`, { x: 410, y: 787, size: 9, font: regular, color: ink });
    target.drawText('E-mail', { x: 368, y: 775, size: 9, font: regular, color: ink });
    target.drawText(`: ${sanitizeText(template.trust_email)}`, { x: 410, y: 775, size: 9, font: regular, color: ink });
    target.drawText('Web-site', { x: 368, y: 763, size: 9, font: regular, color: ink });
    target.drawText(`: ${sanitizeText(template.trust_website)}`, { x: 410, y: 763, size: 9, font: regular, color: ink });

    const brand = sanitizeText(template.brand_title || 'BumbleB');
    target.drawText(brand, { x: (width - bold.widthOfTextAtSize(brand, 24)) / 2, y: 704, size: 24, font: bold, color: navy });
    if (template.brand_subtitle) {
      const subtitle = sanitizeText(template.brand_subtitle);
      target.drawText(subtitle, { x: (width - regular.widthOfTextAtSize(subtitle, 7.5)) / 2, y: 688, size: 7.5, font: regular, color: ink });
    }

    const regn = sanitizeText(template.trust_regn);
    if (regn) target.drawText(regn, { x: (width - regular.widthOfTextAtSize(regn, 8.5)) / 2, y: 674, size: 8.5, font: regular, color: ink });
    const address = sanitizeText(template.trust_address);
    if (address) {
      const addressLines = wrapText(address, bold, 8.5, contentWidth - 20);
      let addressY = 660;
      for (const addressLine of addressLines) {
        target.drawText(addressLine, { x: (width - bold.widthOfTextAtSize(addressLine, 8.5)) / 2, y: addressY, size: 8.5, font: bold, color: navy });
        addressY -= 10;
      }
    }
    target.drawLine({ start: { x: margin, y: 647 }, end: { x: width - margin, y: 647 }, thickness: 0.65, color: blue });
  };

  drawHeader(page);
  page.drawText(title, { x: (width - bold.widthOfTextAtSize(title, 11)) / 2, y: 624, size: 11, font: bold, color: ink });
  const titleWidth = bold.widthOfTextAtSize(title, 11);
  page.drawLine({ start: { x: (width - titleWidth) / 2, y: 622 }, end: { x: (width + titleWidth) / 2, y: 622 }, thickness: 0.8, color: ink });
  page.drawText(joiningDate, { x: width - margin - bold.widthOfTextAtSize(joiningDate, 9.5), y: 606, size: 9.5, font: bold, color: ink });

  y = 586;
  page.drawText('Dear ', { x: margin, y, size: 9.5, font: regular, color: ink });
  const dearWidth = regular.widthOfTextAtSize('Dear ', 9.5);
  page.drawText(`${candidateName},`, { x: margin + dearWidth, y, size: 9.5, font: bold, color: ink });
  y -= 13;
  page.drawText(`${location}${district ? `, ${district}` : ''}`, { x: margin, y, size: 9.5, font: regular, color: ink });
  y -= 12;
  const phone = sanitizeText(candidate.phone);
  if (phone) {
    page.drawText(`Phone: ${phone}`, { x: margin, y, size: 9.5, font: regular, color: ink });
  }
  y -= 12;
  const emailLabel = 'Email ID: ';
  page.drawText(emailLabel, { x: margin, y, size: 9.5, font: regular, color: ink });
  page.drawText(email, { x: margin + regular.widthOfTextAtSize(emailLabel, 9.5), y, size: 9.5, font: regular, color: linkBlue });
  y -= 28;
  const greeting = sanitizeText(template.greeting);
  if (greeting) {
    page.drawText(greeting, { x: margin, y, size: 9.5, font: bold, color: ink });
    y -= 22;
  }
  const drawParagraphLines = (target: PDFPage, lines: string[], startY: number) => {
    let cursor = startY;
    for (const line of lines) {
      if (cursor < 105) {
        drawFooter(target, width, template, regular, logoImage);
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
      drawFooter(page, width, template, regular, logoImage);
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
          drawFooter(page, width, template, regular, logoImage);
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
    if (text === template.closing) {
      page.drawText('Prem Kumar Gokuladasan', { x: margin, y: y - 8, size: 9.5, font: bold, color: ink });
      y -= 13;
    }
  }
  drawFooter(page, width, template, regular, logoImage);
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
