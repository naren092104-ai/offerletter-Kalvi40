import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { createClient } from '@supabase/supabase-js';
import { db, getSetting, pdfStorageDir, uploadsStorageDir } from './db.ts';
import {
  DEFAULT_OFFER_LETTER_TEMPLATE,
  formatDateDDMMYYYY,
  normalizeSchoolName,
  renderTemplateString,
  sanitizeOfferFilename,
  type Candidate,
  type FounderSignatureInfo,
  type OfferLetterTemplate,
} from '../src/types/kalvi40.ts';

interface TextSegment {
  text: string;
  bold?: boolean;
  color?: ReturnType<typeof rgb>;
}

const DARK_INK = rgb(0.11, 0.14, 0.2);
const NAVY_INK = rgb(0.063, 0.141, 0.227);
const MUTED_INK = rgb(0.22, 0.25, 0.31);
const LINK_BLUE = rgb(0.114, 0.306, 0.686);
const LINE_BLUE = rgb(0.21, 0.36, 0.62);

/**
 * Safely maps Unicode punctuation/whitespace to WinAnsi-compatible characters so
 * StandardFonts.TimesRoman never fails on smart quotes, em/en dashes, rupee symbols, etc.
 */
export function sanitizeForPdfWinAnsi(input: string): string {
  return (input || '')
    .replace(/\u2018|\u2019|\u201A|\u2032/g, "'")
    .replace(/\u201C|\u201D|\u201E|\u2033/g, '"')
    .replace(/\u2013|\u2014|\u2212/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u20B9/g, 'INR ')
    .replace(/\u2022/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\t/g, '  ')
    // Replace any remaining non-WinAnsi characters safely
    .replace(/[^\x0A\x0D\x20-\x7E\xA0-\xFF]/g, ' ');
}

export function getOfferLetterTemplate(): OfferLetterTemplate {
  const parsedFontSize = Number(getSetting('offer_body_font_size', String(DEFAULT_OFFER_LETTER_TEMPLATE.body_font_size)));
  const bodyFontSize = Number.isFinite(parsedFontSize)
    ? Math.max(9, Math.min(12.5, Number(parsedFontSize.toFixed(1))))
    : DEFAULT_OFFER_LETTER_TEMPLATE.body_font_size;

  return {
    header_name: getSetting('offer_header_name', DEFAULT_OFFER_LETTER_TEMPLATE.header_name),
    header_role: getSetting('offer_header_role', DEFAULT_OFFER_LETTER_TEMPLATE.header_role),
    brand_title: getSetting('offer_brand_title', DEFAULT_OFFER_LETTER_TEMPLATE.brand_title) || DEFAULT_OFFER_LETTER_TEMPLATE.brand_title,
    brand_subtitle: getSetting('offer_brand_subtitle', DEFAULT_OFFER_LETTER_TEMPLATE.brand_subtitle),
    trust_regn: getSetting('trust_regn', DEFAULT_OFFER_LETTER_TEMPLATE.trust_regn),
    trust_address: getSetting('trust_address', DEFAULT_OFFER_LETTER_TEMPLATE.trust_address),
    trust_mobile: getSetting('trust_mobile', DEFAULT_OFFER_LETTER_TEMPLATE.trust_mobile),
    trust_email: getSetting('trust_email', DEFAULT_OFFER_LETTER_TEMPLATE.trust_email),
    trust_website: getSetting('trust_website', DEFAULT_OFFER_LETTER_TEMPLATE.trust_website),
    heading: getSetting('offer_heading', DEFAULT_OFFER_LETTER_TEMPLATE.heading) || DEFAULT_OFFER_LETTER_TEMPLATE.heading,
    greeting: getSetting('offer_greeting', DEFAULT_OFFER_LETTER_TEMPLATE.greeting) || DEFAULT_OFFER_LETTER_TEMPLATE.greeting,
    body: getSetting('offer_body', DEFAULT_OFFER_LETTER_TEMPLATE.body) || DEFAULT_OFFER_LETTER_TEMPLATE.body,
    closing: getSetting('offer_closing', DEFAULT_OFFER_LETTER_TEMPLATE.closing) || DEFAULT_OFFER_LETTER_TEMPLATE.closing,
    signatory_title:
      getSetting('offer_signatory_title', DEFAULT_OFFER_LETTER_TEMPLATE.signatory_title) ||
      DEFAULT_OFFER_LETTER_TEMPLATE.signatory_title,
    signatory_org:
      getSetting('offer_signatory_org', DEFAULT_OFFER_LETTER_TEMPLATE.signatory_org) ||
      DEFAULT_OFFER_LETTER_TEMPLATE.signatory_org,
    contract_end_date:
      getSetting('contract_end_date', DEFAULT_OFFER_LETTER_TEMPLATE.contract_end_date) ||
      DEFAULT_OFFER_LETTER_TEMPLATE.contract_end_date,
    stipend_text:
      getSetting('stipend_text', DEFAULT_OFFER_LETTER_TEMPLATE.stipend_text) ||
      DEFAULT_OFFER_LETTER_TEMPLATE.stipend_text,
    footer_left_url: getSetting('offer_footer_left_url', DEFAULT_OFFER_LETTER_TEMPLATE.footer_left_url),
    footer_right_url: getSetting('offer_footer_right_url', DEFAULT_OFFER_LETTER_TEMPLATE.footer_right_url),
    body_font_size: bodyFontSize,
  };
}

export function getFounderSignatureInfo(): FounderSignatureInfo {
  const filename = getSetting('founder_signature_filename', '').trim();
  const mime = getSetting('founder_signature_mime', 'image/png').trim() || 'image/png';
  const rawHeight = Number(getSetting('founder_signature_height', '40'));
  const heightPt = Number.isFinite(rawHeight) ? Math.max(24, Math.min(72, Math.round(rawHeight))) : 40;
  const updatedAt = getSetting('founder_signature_updated_at', '').trim() || null;

  if (filename) {
    const safeName = path.basename(filename);
    const fullPath = path.join(uploadsStorageDir, safeName);
    if (fs.existsSync(fullPath)) {
      const bytes = fs.readFileSync(fullPath);
      return {
        hasCustomSignature: true,
        heightPt,
        updatedAt,
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      };
    }
  }

  return {
    hasCustomSignature: false,
    heightPt,
    updatedAt: null,
    dataUrl: null,
  };
}

function loadCustomFounderSignature(): { bytes: Buffer; isPng: boolean; heightPt: number } | null {
  const filename = getSetting('founder_signature_filename', '').trim();
  if (!filename) return null;
  const safeName = path.basename(filename);
  const fullPath = path.join(uploadsStorageDir, safeName);
  if (!fs.existsSync(fullPath)) return null;

  const bytes = fs.readFileSync(fullPath);
  if (bytes.length < 12) return null;

  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpg) return null;

  const rawHeight = Number(getSetting('founder_signature_height', '40'));
  const heightPt = Number.isFinite(rawHeight) ? Math.max(24, Math.min(72, Math.round(rawHeight))) : 40;
  return { bytes, isPng, heightPt };
}

function parseBoldSegments(paragraphText: string): TextSegment[] {
  const cleaned = sanitizeForPdfWinAnsi(paragraphText);
  const segments: TextSegment[] = [];
  const regex = /\*\*([\s\S]+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: cleaned.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    segments.push({ text: cleaned.slice(lastIndex), bold: false });
  }

  return segments.length > 0 ? segments : [{ text: cleaned, bold: false }];
}

interface WordToken {
  word: string;
  bold: boolean;
  color: ReturnType<typeof rgb>;
  trailingSpace: boolean;
}

function layoutParagraphLines(params: {
  segments: TextSegment[];
  maxWidth: number;
  fontSize: number;
  regularFont: PDFFont;
  boldFont: PDFFont;
}): WordToken[][] {
  const { segments, maxWidth, fontSize, regularFont, boldFont } = params;
  const tokens: WordToken[] = [];

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const nextSeg = segments[sIdx + 1];
    const nextStartsWithSpace = Boolean(nextSeg && /^\s/.test(nextSeg.text));
    const parts = seg.text.split(/(\s+)/);

    let lastWordPartIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] && !/^\s+$/.test(parts[i])) {
        lastWordPartIdx = i;
        break;
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || /^\s+$/.test(part)) continue;
      const nextPart = parts[i + 1];
      const hasSpaceAfterInSeg = typeof nextPart === 'string' && /^\s+$/.test(nextPart);
      const isLastInSeg = i === lastWordPartIdx;
      const hasSpace = hasSpaceAfterInSeg || (isLastInSeg && nextStartsWithSpace);
      tokens.push({
        word: part,
        bold: Boolean(seg.bold),
        color: seg.color ?? DARK_INK,
        trailingSpace: hasSpace,
      });
    }
  }

  const lines: WordToken[][] = [];
  let currentLine: WordToken[] = [];
  let currentWidth = 0;

  for (const token of tokens) {
    const font = token.bold ? boldFont : regularFont;
    const wordText = token.word + (token.trailingSpace ? ' ' : '');
    const wordWidth = font.widthOfTextAtSize(token.word, fontSize);
    const fullWidth = font.widthOfTextAtSize(wordText, fontSize);

    if (currentLine.length > 0 && currentWidth + wordWidth > maxWidth) {
      lines.push(currentLine);
      currentLine = [token];
      currentWidth = fullWidth;
    } else {
      currentLine.push(token);
      currentWidth += fullWidth;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function drawLaidOutLines(params: {
  page: PDFPage;
  lines: WordToken[][];
  x: number;
  startY: number;
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
  regularFont: PDFFont;
  boldFont: PDFFont;
  justify?: boolean;
}): number {
  const { page, lines, x, startY, maxWidth, fontSize, lineHeight, regularFont, boldFont, justify = true } = params;

  let y = startY;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const isLastLine = lineIdx === lines.length - 1;

    let extraSpacePerGap = 0;
    if (justify && !isLastLine && line.length > 3) {
      let rawLineWidth = 0;
      let spaceCount = 0;
      for (let i = 0; i < line.length; i++) {
        const t = line[i];
        const font = t.bold ? boldFont : regularFont;
        const isEndOfLineToken = i === line.length - 1;
        const txt = t.word + (!isEndOfLineToken && t.trailingSpace ? ' ' : '');
        rawLineWidth += font.widthOfTextAtSize(txt, fontSize);
        if (!isEndOfLineToken && t.trailingSpace) spaceCount++;
      }
      const remaining = maxWidth - rawLineWidth;
      if (spaceCount > 0 && remaining > 0 && remaining < 36) {
        extraSpacePerGap = remaining / spaceCount;
      }
    }

    let cursorX = x;
    for (let i = 0; i < line.length; i++) {
      const t = line[i];
      const font = t.bold ? boldFont : regularFont;
      const isEndOfLineToken = i === line.length - 1;
      page.drawText(t.word, {
        x: cursorX,
        y,
        size: fontSize,
        font,
        color: t.color,
      });
      const wordW = font.widthOfTextAtSize(t.word, fontSize);
      cursorX += wordW;
      if (!isEndOfLineToken && t.trailingSpace) {
        const spaceW = font.widthOfTextAtSize(' ', fontSize);
        cursorX += spaceW + extraSpacePerGap;
      }
    }
    y -= lineHeight;
  }

  return y;
}

async function drawFooter(params: {
  pdfDoc: PDFDocument;
  page: PDFPage;
  width: number;
  marginLeft: number;
  marginRight: number;
  regularFont: PDFFont;
  footerLeftUrl: string;
  footerRightUrl: string;
}): Promise<void> {
  const { pdfDoc, page, width, marginLeft, marginRight, regularFont, footerLeftUrl, footerRightUrl } = params;
  const emblemPath = path.resolve(process.cwd(), 'public/assets/aistudio/unnamed_4b5dc694.png');
  if (fs.existsSync(emblemPath)) {
    const emblemBytes = fs.readFileSync(emblemPath);
    const emblemImg = await pdfDoc.embedPng(emblemBytes);
    page.drawImage(emblemImg, {
      x: marginLeft - 2,
      y: 44,
      width: 56,
      height: 56,
    });
  }

  const footerTextLeft = sanitizeForPdfWinAnsi(footerLeftUrl.trim());
  const footerTextRight = sanitizeForPdfWinAnsi(footerRightUrl.trim());
  const hasBoth = Boolean(footerTextLeft && footerTextRight);
  const footerSep = hasBoth ? ' | ' : '';
  const totalFooterW =
    (footerTextLeft ? regularFont.widthOfTextAtSize(footerTextLeft, 10) : 0) +
    (footerSep ? regularFont.widthOfTextAtSize(footerSep, 10) : 0) +
    (footerTextRight ? regularFont.widthOfTextAtSize(footerTextRight, 10) : 0);
  const footerX = width - marginRight - totalFooterW;
  const footerY = 58;

  let cursorX = footerX;
  if (footerTextLeft) {
    page.drawText(footerTextLeft, { x: cursorX, y: footerY, size: 10, font: regularFont, color: LINK_BLUE });
    const leftW = regularFont.widthOfTextAtSize(footerTextLeft, 10);
    page.drawLine({
      start: { x: cursorX, y: footerY - 1.5 },
      end: { x: cursorX + leftW, y: footerY - 1.5 },
      thickness: 0.6,
      color: LINK_BLUE,
    });
    cursorX += leftW;
  }

  if (footerSep) {
    page.drawText(footerSep, { x: cursorX, y: footerY, size: 10, font: regularFont, color: DARK_INK });
    cursorX += regularFont.widthOfTextAtSize(footerSep, 10);
  }

  if (footerTextRight) {
    page.drawText(footerTextRight, { x: cursorX, y: footerY, size: 10, font: regularFont, color: LINK_BLUE });
    const rightW = regularFont.widthOfTextAtSize(footerTextRight, 10);
    page.drawLine({
      start: { x: cursorX, y: footerY - 1.5 },
      end: { x: cursorX + rightW, y: footerY - 1.5 },
      thickness: 0.6,
      color: LINK_BLUE,
    });
  }
}

export async function buildOfferLetterPdfBuffer(
  candidate: Pick<
    Candidate,
    'candidate_name' | 'school_name' | 'location' | 'district' | 'email' | 'joining_date' | 'custom_offer_body'
  >,
  templateOverride?: Partial<OfferLetterTemplate>
): Promise<{ buffer: Buffer; filename: string }> {
  const pdfDoc = await PDFDocument.create();
  const filename = sanitizeOfferFilename(candidate.candidate_name);
  const formattedDate = formatDateDDMMYYYY(candidate.joining_date);
  const baseTemplate = getOfferLetterTemplate();
  const offerTemplate: OfferLetterTemplate = {
    ...baseTemplate,
    ...(templateOverride || {}),
    body_font_size: Number.isFinite(Number(templateOverride?.body_font_size))
      ? Math.max(9, Math.min(12.5, Number(templateOverride!.body_font_size)))
      : baseTemplate.body_font_size,
  };

  const headerName = sanitizeForPdfWinAnsi(offerTemplate.header_name.trim());
  const headerRole = sanitizeForPdfWinAnsi(offerTemplate.header_role.trim());
  const brandTitle = sanitizeForPdfWinAnsi(offerTemplate.brand_title.trim() || 'BumbleB');
  const subTitle = sanitizeForPdfWinAnsi(offerTemplate.brand_subtitle.trim());
  const trustAddress = sanitizeForPdfWinAnsi(offerTemplate.trust_address.trim());
  const trustRegn = sanitizeForPdfWinAnsi(offerTemplate.trust_regn.trim());
  const trustMobile = sanitizeForPdfWinAnsi(offerTemplate.trust_mobile.trim());
  const trustEmail = sanitizeForPdfWinAnsi(offerTemplate.trust_email.trim());
  const trustWebsite = sanitizeForPdfWinAnsi(offerTemplate.trust_website.trim());
  const footerLeftUrl = offerTemplate.footer_left_url;
  const footerRightUrl = offerTemplate.footer_right_url;

  const safeCandidateName = sanitizeForPdfWinAnsi(candidate.candidate_name.trim());
  const safeSchoolName = sanitizeForPdfWinAnsi(normalizeSchoolName(candidate.school_name));
  const safeLocation = sanitizeForPdfWinAnsi(candidate.location.trim());
  const safeDistrict = sanitizeForPdfWinAnsi(candidate.district.trim());
  const safeEmail = sanitizeForPdfWinAnsi(candidate.email.trim());
  const safePhone = sanitizeForPdfWinAnsi((candidate as Candidate & { phone?: string }).phone?.trim() || '');

  // Set PDF metadata for reliable indexing & verification
  pdfDoc.setTitle(`Engagement Letter - ${safeCandidateName}`);
  pdfDoc.setAuthor('BumbleB Trust - Kalvi40');
  pdfDoc.setSubject(`Teaching Coordinator Engagement Letter | ${safeSchoolName} | ${safeDistrict}`);
  pdfDoc.setKeywords([
    safeCandidateName,
    safeSchoolName,
    safeLocation,
    safeDistrict,
    safeEmail,
    formattedDate,
  ]);
  pdfDoc.setCreator('Kalvi40 Enterprise Offer Letter System');

  // Standard A4 Portrait: 595.28 x 841.89 points
  let page = pdfDoc.addPage([595.28, 841.89]);
  const { width } = page.getSize();

  const regularFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const italicSerif = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const marginLeft = 64;
  const marginRight = 64;
  const contentWidth = width - marginLeft - marginRight;

  // =========================================================================
  // LETTERHEAD HEADER (Reproducing original BumbleB Trust PDF Header)
  // =========================================================================
  if (headerName) {
    page.drawText(headerName, {
      x: marginLeft,
      y: 785,
      size: 9,
      font: boldFont,
      color: DARK_INK,
    });
  }
  if (headerRole) {
    page.drawText(headerRole, {
      x: marginLeft,
      y: 771,
      size: 10.5,
      font: italicSerif,
      color: MUTED_INK,
    });
  }

  const rightColX = 368;
  if (trustMobile) {
    page.drawText('Mobile', { x: rightColX, y: 787, size: 9, font: regularFont, color: DARK_INK });
    page.drawText(`: ${trustMobile}`, { x: rightColX + 42, y: 787, size: 9, font: regularFont, color: DARK_INK });
  }
  if (trustEmail) {
    page.drawText('E-mail', { x: rightColX, y: 775, size: 9, font: regularFont, color: DARK_INK });
    page.drawText(`: ${trustEmail}`, { x: rightColX + 42, y: 775, size: 9, font: regularFont, color: DARK_INK });
  }
  if (trustWebsite) {
    page.drawText('Web-site', { x: rightColX, y: 763, size: 9, font: regularFont, color: DARK_INK });
    page.drawText(`: ${trustWebsite}`, { x: rightColX + 42, y: 763, size: 9, font: regularFont, color: DARK_INK });
  }

  const brandWidth = boldFont.widthOfTextAtSize(brandTitle, 22);
  page.drawText(brandTitle, {
    x: (width - brandWidth) / 2,
    y: 744,
    size: 22,
    font: boldFont,
    color: NAVY_INK,
  });

  if (subTitle) {
    const subWidth = boldFont.widthOfTextAtSize(subTitle, 8);
    page.drawText(subTitle, {
      x: (width - subWidth) / 2,
      y: 730,
      size: 8,
      font: boldFont,
      color: NAVY_INK,
    });
  }

  if (trustRegn) {
    const regnWidth = regularFont.widthOfTextAtSize(trustRegn, 9.5);
    page.drawText(trustRegn, {
      x: (width - regnWidth) / 2,
      y: 707,
      size: 9.5,
      font: regularFont,
      color: DARK_INK,
    });
  }

  if (trustAddress) {
    const addrWidth = boldFont.widthOfTextAtSize(trustAddress, 9.5);
    page.drawText(trustAddress, {
      x: (width - addrWidth) / 2,
      y: 693,
      size: 9.5,
      font: boldFont,
      color: NAVY_INK,
    });
  }

  page.drawLine({
    start: { x: 60, y: 684 },
    end: { x: width - 60, y: 684 },
    thickness: 1.0,
    color: LINE_BLUE,
  });

  // =========================================================================
  // HEADING & DATE
  // =========================================================================
  const heading = sanitizeForPdfWinAnsi(offerTemplate.heading.trim() || 'ENGAGEMENT LETTER');
  const headingWidth = boldFont.widthOfTextAtSize(heading, 11.5);
  const headingX = (width - headingWidth) / 2;
  page.drawText(heading, {
    x: headingX,
    y: 659,
    size: 11.5,
    font: boldFont,
    color: DARK_INK,
  });
  page.drawLine({
    start: { x: headingX, y: 657 },
    end: { x: headingX + headingWidth, y: 657 },
    thickness: 0.9,
    color: DARK_INK,
  });

  const dateWidth = boldFont.widthOfTextAtSize(formattedDate, 10.5);
  page.drawText(formattedDate, {
    x: width - marginRight - dateWidth,
    y: 641,
    size: 10.5,
    font: boldFont,
    color: DARK_INK,
  });

  // =========================================================================
  // RECIPIENT DETAILS (Candidate-Specific Fields)
  // =========================================================================
  let cursorY = 621;
  page.drawText('Dear ', {
    x: marginLeft,
    y: cursorY,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });
  const dearW = regularFont.widthOfTextAtSize('Dear ', 10.5);
  page.drawText(`${safeCandidateName},`, {
    x: marginLeft + dearW,
    y: cursorY,
    size: 10.5,
    font: boldFont,
    color: DARK_INK,
  });

  cursorY -= 14;
  page.drawText(`${safeLocation}, ${safeDistrict}`, {
    x: marginLeft,
    y: cursorY,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });

  cursorY -= 14;
  if (safePhone) {
    page.drawText(`Phone: ${safePhone}`, {
      x: marginLeft,
      y: cursorY,
      size: 10.5,
      font: regularFont,
      color: DARK_INK,
    });
  }

  cursorY -= 14;
  const emailLabel = 'Email ID: ';
  page.drawText(emailLabel, {
    x: marginLeft,
    y: cursorY,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });
  const emailLabelW = regularFont.widthOfTextAtSize(emailLabel, 10.5);
  page.drawText(safeEmail, {
    x: marginLeft + emailLabelW,
    y: cursorY,
    size: 10.5,
    font: regularFont,
    color: LINK_BLUE,
  });

  // =========================================================================
  // BODY CONTENT (Editable Master Template or Candidate-Specific Override)
  // =========================================================================
  cursorY -= 30;
  const greetingText = sanitizeForPdfWinAnsi(
    renderTemplateString(offerTemplate.greeting, candidate, {
      contract_end_date: offerTemplate.contract_end_date,
      stipend_text: offerTemplate.stipend_text,
    })
  );
  page.drawText(greetingText, {
    x: marginLeft,
    y: cursorY,
    size: 10.5,
    font: boldFont,
    color: DARK_INK,
  });

  const activeBodyTemplate =
    candidate.custom_offer_body && candidate.custom_offer_body.trim()
      ? candidate.custom_offer_body
      : offerTemplate.body;

  const renderedBodyRaw = renderTemplateString(activeBodyTemplate, candidate, {
    contract_end_date: offerTemplate.contract_end_date,
    stipend_text: offerTemplate.stipend_text,
  })
    .replace(/\r\n/g, '\n')
    // Clean accidental duplicate punctuation around placeholders (e.g., "..")
    .replace(/\.\.(?!\.)/g, '.');

  const paragraphs = renderedBodyRaw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const fontSize = offerTemplate.body_font_size || 10.5;
  const lineHeight = Number((fontSize * 1.43).toFixed(2));
  const paragraphGap = 10;
  const bottomLimitForText = 120;

  cursorY -= 25;

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    // Support intentional single line breaks inside a paragraph
    const subLines = paragraphs[pIdx].split('\n').map((s) => s.trim()).filter(Boolean);
    for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
      const segments = parseBoldSegments(subLines[sIdx]);
      const laidOut = layoutParagraphLines({
        segments,
        maxWidth: contentWidth,
        fontSize,
        regularFont,
        boldFont,
      });

      const neededHeight = laidOut.length * lineHeight;
      if (cursorY - neededHeight < bottomLimitForText) {
        await drawFooter({ pdfDoc, page, width, marginLeft, marginRight, regularFont, footerLeftUrl, footerRightUrl });
        page = pdfDoc.addPage([595.28, 841.89]);
        cursorY = 780;
      }

      cursorY = drawLaidOutLines({
        page,
        lines: laidOut,
        x: marginLeft,
        startY: cursorY,
        maxWidth: contentWidth,
        fontSize,
        lineHeight,
        regularFont,
        boldFont,
        justify: true,
      });
    }

    if (pIdx < paragraphs.length - 1) {
      cursorY -= paragraphGap;
    }
  }

  // =========================================================================
  // SIGNATURE BLOCK (Uses uploaded Founder signature image or default vector)
  // =========================================================================
  const customSig = loadCustomFounderSignature();
  let embeddedSigImg: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  let sigDrawW = 0;
  let sigDrawH = 38;

  if (customSig) {
    try {
      embeddedSigImg = customSig.isPng
        ? await pdfDoc.embedPng(customSig.bytes)
        : await pdfDoc.embedJpg(customSig.bytes);
      const dims = embeddedSigImg.scale(1);
      const maxSigWidth = 185;
      let targetH = customSig.heightPt;
      let targetW = dims.height > 0 ? (dims.width / dims.height) * targetH : 110;
      if (targetW > maxSigWidth) {
        const ratio = maxSigWidth / targetW;
        targetW = maxSigWidth;
        targetH = targetH * ratio;
      }
      sigDrawW = targetW;
      sigDrawH = targetH;
    } catch (err) {
      console.warn('Unable to embed custom founder signature; falling back to default:', err);
      embeddedSigImg = null;
    }
  }

  const signatureNeededHeight = (embeddedSigImg ? sigDrawH + 46 : 80);
  if (cursorY - signatureNeededHeight < 110) {
    await drawFooter({ pdfDoc, page, width, marginLeft, marginRight, regularFont, footerLeftUrl, footerRightUrl });
    page = pdfDoc.addPage([595.28, 841.89]);
    cursorY = 770;
  }

  cursorY -= 16;
  page.drawText(sanitizeForPdfWinAnsi(offerTemplate.closing.trim() || 'With regards,'), {
    x: marginLeft,
    y: cursorY,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });

  let signTitleY = cursorY - 46;
  if (embeddedSigImg) {
    const imgTopY = cursorY - 8;
    const imgBottomY = imgTopY - sigDrawH;
    page.drawImage(embeddedSigImg, {
      x: marginLeft,
      y: imgBottomY,
      width: sigDrawW,
      height: sigDrawH,
    });
    signTitleY = imgBottomY - 14;
  } else {
    const sigTopY = cursorY - 6;
    page.drawSvgPath(
      'M 2 18 C 8 6, 13 2, 11 10 C 9 18, 4 21, 10 19 C 16 17, 24 12, 26 8 C 28 4, 24 14, 27 17 C 30 20, 35 14, 41 11 C 46 8, 50 18, 55 15 C 60 12, 66 2, 69 1 C 72 0, 61 28, 56 32 C 51 36, 46 28, 58 21 C 68 15, 78 13, 88 13',
      {
        x: marginLeft + 2,
        y: sigTopY,
        borderColor: rgb(0.18, 0.24, 0.36),
        borderWidth: 1.35,
        scale: 0.92,
      }
    );
  }

  page.drawText(sanitizeForPdfWinAnsi(offerTemplate.signatory_title.trim() || 'Founder & Managing Trustee'), {
    x: marginLeft,
    y: signTitleY,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });
  page.drawText(sanitizeForPdfWinAnsi(offerTemplate.signatory_org.trim() || 'BumbleB Trust, Chennai'), {
    x: marginLeft,
    y: signTitleY - 14,
    size: 10.5,
    font: regularFont,
    color: DARK_INK,
  });

  // =========================================================================
  // FOOTER (Kalvi40 Emblem + Website Links)
  // =========================================================================
  await drawFooter({ pdfDoc, page, width, marginLeft, marginRight, regularFont, footerLeftUrl, footerRightUrl });

  const pdfBytes = await pdfDoc.save();
  const buffer = Buffer.from(pdfBytes);

  return { buffer, filename };
}

export async function generateOfferLetterPdf(candidate: Candidate): Promise<{
  buffer: Buffer;
  filename: string;
  filePath: string;
}> {
  const { buffer, filename } = await buildOfferLetterPdfBuffer(candidate);

  const filePath = path.join(pdfStorageDir, filename);
  fs.writeFileSync(filePath, buffer);

  db.prepare(`
    UPDATE candidates
    SET offer_generated = 1,
        offer_generated_at = datetime('now'),
        offer_filename = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(filename, candidate.id);

  // Optional Supabase Storage upload when configured
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET || 'offer-letters';
  if (supabaseUrl && supabaseKey && !supabaseUrl.includes('your-project-ref')) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.storage.from(supabaseBucket).upload(filename, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    } catch (err) {
      console.warn('Optional Supabase Storage upload skipped:', err instanceof Error ? err.message : String(err));
    }
  }

  return { buffer, filename, filePath };
}

/**
 * Extracts actual drawn text tokens from the PDF binary content streams
 * (decompressing FlateDecode streams with zlib) so verification genuinely inspects
 * the generated PDF file contents rather than trusting memory.
 */
export function extractTextFromPdfBuffer(pdfBuffer: Buffer): string {
  const raw = pdfBuffer.toString('latin1');
  const extractedChunks: string[] = [];

  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    const streamData = Buffer.from(match[1], 'latin1');
    let textStream = '';
    try {
      textStream = zlib.inflateSync(streamData).toString('latin1');
    } catch {
      textStream = streamData.toString('latin1');
    }

    // Match PDF literal strings (...) and hex strings <...> inside Tj / TJ operators
    const literalRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let litMatch: RegExpExecArray | null;
    while ((litMatch = literalRegex.exec(textStream)) !== null) {
      const unescaped = litMatch[1]
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, ' ');
      if (unescaped.trim()) {
        extractedChunks.push(unescaped);
      }
    }

    const hexRegex = /<([0-9A-Fa-f\s]+)>/g;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = hexRegex.exec(textStream)) !== null) {
      const cleanHex = hexMatch[1].replace(/\s+/g, '');
      if (cleanHex.length >= 2 && cleanHex.length % 2 === 0) {
        const decoded = Buffer.from(cleanHex, 'hex').toString('latin1');
        if (/^[\x20-\x7E]+$/.test(decoded)) {
          extractedChunks.push(decoded);
        }
      }
    }
  }

  return extractedChunks.join(' ').replace(/\s+/g, ' ').trim();
}
