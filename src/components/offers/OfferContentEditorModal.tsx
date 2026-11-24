import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, PenTool, RotateCcw, Save, Sparkles, User, Users, X } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { useToast } from '../ui/Toast';
import { FounderSignatureModal } from './FounderSignatureUploader';
import {
  DEFAULT_OFFER_LETTER_TEMPLATE,
  OFFER_TEMPLATE_PLACEHOLDERS,
  formatDateDDMMYYYY,
  renderTemplateString,
  type Candidate,
  type FounderSignatureInfo,
  type OfferLetterTemplate,
} from '../../types/kalvi40';

interface OfferContentEditorModalProps {
  open: boolean;
  candidate?: Candidate | null;
  onClose: () => void;
  onSaved: () => void;
}

const SAMPLE_CANDIDATE: Pick<
  Candidate,
  'candidate_name' | 'school_name' | 'location' | 'district' | 'email' | 'joining_date'
> = {
  candidate_name: 'E Sathiya Kaviya',
  school_name: 'Govt Panchayat Union Middle School',
  location: 'Pattiyandal',
  district: 'Tiruvannamalai',
  email: 'candidate@example.com',
  joining_date: '21.10.2026',
};

function renderFormattedLine(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-bold text-[#10243A]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export function OfferContentEditorModal({
  open,
  candidate = null,
  onClose,
  onSaved,
}: OfferContentEditorModalProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'candidate' | 'master'>(candidate ? 'candidate' : 'master');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [masterTemplate, setMasterTemplate] = useState<OfferLetterTemplate>(DEFAULT_OFFER_LETTER_TEMPLATE);
  const [customBody, setCustomBody] = useState('');
  const [signatureInfo, setSignatureInfo] = useState<FounderSignatureInfo | null>(null);
  const [signatureModalOpen, setSignatureModalOpen] = useState(false);

  const candidateTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const masterTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(candidate ? 'candidate' : 'master');
    let active = true;

    async function loadOfferTemplate() {
      setLoading(true);
      try {
        const [res, sigRes] = await Promise.all([
          apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer'),
          apiRequest<{ signature: FounderSignatureInfo }>('/api/settings/signature'),
        ]);
        if (!active) return;
        setMasterTemplate(res.template);
        setSignatureInfo(sigRes.signature);
        if (candidate) {
          setCustomBody(candidate.custom_offer_body?.trim() ? candidate.custom_offer_body : res.template.body);
        } else {
          setCustomBody('');
        }
      } catch (err) {
        if (!active) return;
        toast({
          title: 'Failed to load offer template',
          description: err instanceof Error ? err.message : 'Unable to fetch offer letter content.',
          variant: 'error',
        });
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadOfferTemplate();
    return () => {
      active = false;
    };
  }, [open, candidate]);

  const previewCandidate = candidate ?? SAMPLE_CANDIDATE;

  const activeBodyRaw = mode === 'candidate' && candidate ? customBody : masterTemplate.body;

  const resolvedPreviewParagraphs = useMemo(() => {
    const resolved = renderTemplateString(activeBodyRaw, previewCandidate, {
      contract_end_date: masterTemplate.contract_end_date,
      stipend_text: masterTemplate.stipend_text,
    }).replace(/\.{2,}/g, '.');
    return resolved
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [activeBodyRaw, previewCandidate, masterTemplate.contract_end_date, masterTemplate.stipend_text]);

  function insertPlaceholder(token: string) {
    const ref = mode === 'candidate' ? candidateTextareaRef.current : masterTextareaRef.current;
    const currentValue = mode === 'candidate' ? customBody : masterTemplate.body;
    if (!ref) {
      if (mode === 'candidate') {
        setCustomBody((prev) => `${prev}${prev.endsWith(' ') || !prev ? '' : ' '}${token}`);
      } else {
        setMasterTemplate((prev) => ({
          ...prev,
          body: `${prev.body}${prev.body.endsWith(' ') || !prev.body ? '' : ' '}${token}`,
        }));
      }
      return;
    }

    const start = ref.selectionStart ?? currentValue.length;
    const end = ref.selectionEnd ?? currentValue.length;
    const updated = `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`;

    if (mode === 'candidate') {
      setCustomBody(updated);
    } else {
      setMasterTemplate((prev) => ({ ...prev, body: updated }));
    }

    requestAnimationFrame(() => {
      ref.focus();
      const nextPos = start + token.length;
      ref.setSelectionRange(nextPos, nextPos);
    });
  }

  async function handleSaveCandidateContent() {
    if (!candidate) return;
    if (!customBody.trim()) {
      toast({
        title: 'Offer content required',
        description: 'Enter the offer letter body or clear the override to use the master template.',
        variant: 'warning',
      });
      return;
    }
    setSaving(true);
    try {
      const res = await apiRequest<{ filename: string }>(`/api/candidates/${candidate.id}/offer-content`, {
        method: 'PUT',
        body: JSON.stringify({ custom_offer_body: customBody.trim() }),
      });
      toast({
        title: 'Custom Offer Content Saved',
        description: `Regenerated ${res.filename} for ${candidate.candidate_name}.`,
        variant: 'success',
      });
      onSaved();
      onClose();
    } catch (err) {
      toast({
        title: 'Failed to save custom offer content',
        description: err instanceof Error ? err.message : 'Unable to save.',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCandidateOverride() {
    if (!candidate) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ filename: string }>(`/api/candidates/${candidate.id}/offer-content`, {
        method: 'PUT',
        body: JSON.stringify({ custom_offer_body: '' }),
      });
      setCustomBody(masterTemplate.body);
      toast({
        title: 'Reverted to Master Template',
        description: `Regenerated ${res.filename} using the master offer letter template.`,
        variant: 'success',
      });
      onSaved();
      onClose();
    } catch (err) {
      toast({
        title: 'Unable to clear override',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMasterTemplate() {
    if (!masterTemplate.heading.trim() || !masterTemplate.body.trim()) {
      toast({
        title: 'Required fields missing',
        description: 'Offer heading and body content cannot be empty.',
        variant: 'warning',
      });
      return;
    }
    setSaving(true);
    try {
      const res = await apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer', {
        method: 'PUT',
        body: JSON.stringify(masterTemplate),
      });
      setMasterTemplate(res.template);
      toast({
        title: 'Master Offer Template Updated',
        description: 'All candidate offer PDFs will use this updated content on preview, download, and send.',
        variant: 'success',
      });
      onSaved();
      onClose();
    } catch (err) {
      toast({
        title: 'Failed to update master offer template',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleResetMasterTemplate() {
    setResetting(true);
    try {
      const res = await apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer/reset', {
        method: 'POST',
      });
      setMasterTemplate(res.template);
      if (candidate && !candidate.custom_offer_body) {
        setCustomBody(res.template.body);
      }
      toast({
        title: 'Master Offer Reset',
        description: 'Restored the original BumbleB Trust Engagement Letter wording.',
        variant: 'success',
      });
      onSaved();
    } catch (err) {
      toast({
        title: 'Reset failed',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setResetting(false);
    }
  }

  if (!open) return null;

  const hasExistingOverride = Boolean(candidate?.custom_offer_body?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-6xl w-full max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <FileText className="w-5 h-5 text-[#2563EB]" />
            <div>
              <h3 className="text-base font-semibold text-[#10243A]">
                Edit Offer Letter PDF Content
              </h3>
              <p className="text-xs text-slate-500">
                Customize the Engagement Letter wording while preserving the official BumbleB Trust letterhead, Times New Roman layout, and signature.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSignatureModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <PenTool className="w-3.5 h-3.5 text-[#2563EB]" />
              <span>Founder Signature</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
              aria-label="Close offer editor"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Mode Switcher when candidate is provided */}
        {candidate && (
          <div className="px-6 py-2.5 bg-[#F7F8FA] border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode('candidate')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-colors ${
                  mode === 'candidate' ? 'bg-[#2563EB] text-white' : 'text-slate-600 hover:text-[#10243A]'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                <span>This Candidate Only ({candidate.candidate_name})</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('master')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-colors ${
                  mode === 'master' ? 'bg-[#2563EB] text-white' : 'text-slate-600 hover:text-[#10243A]'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>Master Offer Template (All Candidates)</span>
              </button>
            </div>

            <div className="text-xs text-slate-600">
              {hasExistingOverride ? (
                <span className="font-semibold text-[#2563EB]">Custom offer override active for this candidate</span>
              ) : (
                <span>Currently using the Master Offer Template</span>
              )}
            </div>
          </div>
        )}

        {/* Body Split */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-slate-500">
            Loading offer letter template...
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            {/* LEFT: Editor */}
            <div className="p-6 space-y-4">
              {mode === 'candidate' && candidate ? (
                <>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded-lg p-3.5 text-xs space-y-1">
                    <div className="font-semibold text-[#10243A]">{candidate.candidate_name}</div>
                    <div className="text-slate-600">
                      {candidate.school_name} · {candidate.location}, {candidate.district}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {candidate.email} · Joining Date: {formatDateDDMMYYYY(candidate.joining_date)}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-[#10243A]">
                        Candidate Offer Letter Body Paragraphs
                      </label>
                      <button
                        type="button"
                        onClick={() => setCustomBody(masterTemplate.body)}
                        className="text-[11px] font-medium text-[#2563EB] hover:underline"
                      >
                        Load Current Master Text
                      </button>
                    </div>
                    <textarea
                      ref={candidateTextareaRef}
                      rows={13}
                      value={customBody}
                      onChange={(e) => setCustomBody(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-xs leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] font-sans"
                      placeholder="Write the personalized offer letter body paragraphs..."
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">
                      Use <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">**bold text**</code> for bold emphasis. Separate paragraphs with a blank line.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Document Heading</label>
                      <input
                        type="text"
                        value={masterTemplate.heading}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, heading: e.target.value })}
                        placeholder="ENGAGEMENT LETTER"
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Greeting Line</label>
                      <input
                        type="text"
                        value={masterTemplate.greeting}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, greeting: e.target.value })}
                        placeholder="Greetings from BumbleB Trust - Kalvi40!!"
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Contract End Date</label>
                      <input
                        type="text"
                        value={masterTemplate.contract_end_date}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, contract_end_date: e.target.value })}
                        placeholder="30.04.2027"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Stipend Clause</label>
                      <input
                        type="text"
                        value={masterTemplate.stipend_text}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, stipend_text: e.target.value })}
                        placeholder="INR. 3000/- per month with effect from Oct 2026 as stipend."
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">
                      Offer Letter Body Paragraphs
                    </label>
                    <textarea
                      ref={masterTextareaRef}
                      rows={10}
                      value={masterTemplate.body}
                      onChange={(e) => setMasterTemplate({ ...masterTemplate, body: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-xs leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] font-sans"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Use <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">**bold text**</code> for bold words and blank lines between paragraphs.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Closing Line</label>
                      <input
                        type="text"
                        value={masterTemplate.closing}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, closing: e.target.value })}
                        className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Signatory Title</label>
                      <input
                        type="text"
                        value={masterTemplate.signatory_title}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, signatory_title: e.target.value })}
                        className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#10243A] mb-1">Signatory Org</label>
                      <input
                        type="text"
                        value={masterTemplate.signatory_org}
                        onChange={(e) => setMasterTemplate({ ...masterTemplate, signatory_org: e.target.value })}
                        className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Clickable Dynamic Placeholders */}
              <div className="pt-2 border-t border-slate-200">
                <div className="text-[11px] font-semibold text-slate-500 mb-2">
                  Insert Dynamic Placeholder into Offer Body:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {OFFER_TEMPLATE_PLACEHOLDERS.map((ph) => (
                    <button
                      key={ph.key}
                      type="button"
                      onClick={() => insertPlaceholder(ph.key)}
                      title={`Insert ${ph.label}`}
                      className="px-2 py-1 text-[11px] font-mono bg-[#F7F8FA] hover:bg-blue-50 text-[#10243A] hover:text-[#2563EB] border border-slate-200 hover:border-blue-300 rounded transition-colors"
                    >
                      {ph.key}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT: Live Resolved Offer Content Preview */}
            <div className="p-6 bg-[#F7F8FA] space-y-3">
              <div className="flex items-center justify-between">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#10243A]">
                  <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
                  <span>Live Resolved Offer Content Preview</span>
                </div>
                <span className="text-[11px] text-slate-500">
                  {candidate ? `Previewing for ${candidate.candidate_name}` : 'Sample candidate preview'}
                </span>
              </div>

              <div
                className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm space-y-3.5 text-[13px] leading-relaxed text-[#10243A]"
                style={{ fontFamily: '"Times New Roman", Times, Georgia, serif' }}
              >
                <div className="text-center font-bold tracking-wide underline text-[14px]">
                  {masterTemplate.heading || 'ENGAGEMENT LETTER'}
                </div>

                <div className="flex justify-between items-start text-[12px] pt-1">
                  <div>
                    <div>
                      Dear <strong className="font-bold">{previewCandidate.candidate_name},</strong>
                    </div>
                    <div>
                      {previewCandidate.location}, {previewCandidate.district}
                    </div>
                    <div>
                      Email ID: <span className="text-[#2563EB] underline">{previewCandidate.email}</span>
                    </div>
                  </div>
                  <div className="font-bold">{formatDateDDMMYYYY(previewCandidate.joining_date)}</div>
                </div>

                <div className="font-bold pt-1">
                  {masterTemplate.greeting || 'Greetings from BumbleB Trust - Kalvi40!!'}
                </div>

                <div className="space-y-3 text-justify">
                  {resolvedPreviewParagraphs.length === 0 ? (
                    <p className="italic text-slate-400">Enter offer letter body text to preview...</p>
                  ) : (
                    resolvedPreviewParagraphs.map((para, idx) => (
                      <p key={idx} className="whitespace-pre-line">
                        {renderFormattedLine(para)}
                      </p>
                    ))
                  )}
                </div>

                <div className="pt-3 space-y-1 text-[12.5px]">
                  <div>{masterTemplate.closing || 'With regards,'}</div>
                  <div className="py-1.5 min-h-[44px] flex items-center">
                    {signatureInfo?.hasCustomSignature && signatureInfo.dataUrl ? (
                      <img
                        src={signatureInfo.dataUrl}
                        alt="Founder Signature"
                        style={{ height: `${Math.round((signatureInfo.heightPt || 40) * 1.1)}px`, maxWidth: '185px' }}
                        className="object-contain object-left"
                      />
                    ) : (
                      <svg width="96" height="36" viewBox="0 0 92 38" fill="none" className="text-[#2E3D5C]">
                        <path
                          d="M 2 18 C 8 6, 13 2, 11 10 C 9 18, 4 21, 10 19 C 16 17, 24 12, 26 8 C 28 4, 24 14, 27 17 C 30 20, 35 14, 41 11 C 46 8, 50 18, 55 15 C 60 12, 66 2, 69 1 C 72 0, 61 28, 56 32 C 51 36, 46 28, 58 21 C 68 15, 78 13, 88 13"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                  <div>{masterTemplate.signatory_title || 'Founder & Managing Trustee'}</div>
                  <div>{masterTemplate.signatory_org || 'BumbleB Trust, Chennai'}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-[#F7F8FA] border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            {mode === 'candidate' && candidate ? (
              hasExistingOverride && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleClearCandidateOverride}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Use Master Template (Clear Override)</span>
                </button>
              )
            ) : (
              <button
                type="button"
                disabled={resetting || saving}
                onClick={handleResetMasterTemplate}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{resetting ? 'Resetting...' : 'Reset to Default'}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            {mode === 'candidate' && candidate ? (
              <button
                type="button"
                disabled={saving || loading}
                onClick={handleSaveCandidateContent}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Saving & Regenerating PDF...' : 'Save & Regenerate PDF'}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={saving || loading}
                onClick={handleSaveMasterTemplate}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Saving Template...' : 'Save Master Offer Template'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <FounderSignatureModal
        open={signatureModalOpen}
        onClose={() => setSignatureModalOpen(false)}
        onUpdated={(sig) => {
          setSignatureInfo(sig);
          onSaved();
        }}
      />
    </div>
  );
}
