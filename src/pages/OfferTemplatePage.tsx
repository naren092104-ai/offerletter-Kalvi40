import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold,
  Building2,
  FileText,
  Mail,
  PenTool,
  Plus,
  RotateCcw,
  Save,
} from 'lucide-react';
import { apiRequest, getAuthToken } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PdfCanvasViewer } from '../components/pdf/PdfCanvasViewer';
import { FounderSignatureUploader } from '../components/offers/FounderSignatureUploader';
import {
  DEFAULT_OFFER_LETTER_TEMPLATE,
  OFFER_TEMPLATE_PLACEHOLDERS,
  sanitizeOfferFilename,
  type Candidate,
  type OfferLetterTemplate,
} from '../types/kalvi40';
import type { NavPageId } from '../components/layout/Sidebar';

interface OfferTemplatePageProps {
  onNavigate: (page: NavPageId) => void;
}

type EditorTab = 'body' | 'letterhead' | 'signature';

export function OfferTemplatePage({ onNavigate }: OfferTemplatePageProps) {
  const { toast } = useToast();
  const [template, setTemplate] = useState<OfferLetterTemplate>(DEFAULT_OFFER_LETTER_TEMPLATE);
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [previewCandidateId, setPreviewCandidateId] = useState<number | ''>('');
  const [activeTab, setActiveTab] = useState<EditorTab>('body');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const [previewPdfBytes, setPreviewPdfBytes] = useState<Uint8Array | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    async function loadInitial() {
      setLoading(true);
      try {
        const [tplRes, candRes] = await Promise.all([
          apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer'),
          apiRequest<{ items: Candidate[] }>('/api/candidates?all=true'),
        ]);
        setTemplate(tplRes.template);
        setSavedSnapshot(JSON.stringify(tplRes.template));
        setCandidates(candRes.items);
        if (candRes.items.length > 0) {
          setPreviewCandidateId(candRes.items[0].id);
        }
      } catch (err) {
        toast({
          title: 'Failed to load offer template',
          description: err instanceof Error ? err.message : 'Error',
          variant: 'error',
        });
      } finally {
        setLoading(false);
      }
    }
    void loadInitial();
  }, []);

  const fetchLivePreviewPdf = useCallback(
    async (draft: OfferLetterTemplate, candId: number | '', signal?: AbortSignal) => {
      setPreviewLoading(true);
      try {
        const token = getAuthToken();
        const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
        const res = await fetch(`${apiBase}/api/templates/offer/preview-pdf`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            template: draft,
            candidateId: typeof candId === 'number' ? candId : undefined,
          }),
          signal,
        });
        if (!res.ok) {
          throw new Error(`Preview failed (HTTP ${res.status})`);
        }
        const buf = await res.arrayBuffer();
        if (!signal?.aborted) {
          setPreviewPdfBytes(new Uint8Array(buf));
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        toast({
          title: 'Unable to render live PDF preview',
          description: err instanceof Error ? err.message : 'Error',
          variant: 'error',
        });
      } finally {
        if (!signal?.aborted) {
          setPreviewLoading(false);
        }
      }
    },
    [toast]
  );

  // Debounced live A4 PDF regeneration whenever any template field, sample candidate, or signature changes
  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchLivePreviewPdf(template, previewCandidateId, controller.signal);
    }, 420);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [template, previewCandidateId, previewNonce, loading, fetchLivePreviewPdf]);

  const hasUnsavedChanges = savedSnapshot !== '' && JSON.stringify(template) !== savedSnapshot;

  function updateField<K extends keyof OfferLetterTemplate>(key: K, value: OfferLetterTemplate[K]) {
    setTemplate((prev) => ({ ...prev, [key]: value }));
  }

  function insertPlaceholder(token: string) {
    const el = bodyTextareaRef.current;
    if (!el) {
      updateField('body', `${template.body}${template.body.endsWith(' ') || !template.body ? '' : ' '}${token}`);
      return;
    }
    const start = el.selectionStart ?? template.body.length;
    const end = el.selectionEnd ?? template.body.length;
    const next = `${template.body.slice(0, start)}${token}${template.body.slice(end)}`;
    updateField('body', next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function wrapSelectionBold() {
    const el = bodyTextareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = template.body.slice(start, end) || 'bold text';
    const wrapped = selected.startsWith('**') && selected.endsWith('**')
      ? selected.slice(2, -2)
      : `**${selected}**`;
    const next = `${template.body.slice(0, start)}${wrapped}${template.body.slice(end)}`;
    updateField('body', next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + wrapped.length);
    });
  }

  async function handleSaveTemplate() {
    if (!template.heading.trim() || !template.body.trim()) {
      toast({
        title: 'Heading and body required',
        description: 'Document heading and offer body paragraphs cannot be empty.',
        variant: 'warning',
      });
      return;
    }
    setSaving(true);
    try {
      const res = await apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer', {
        method: 'PUT',
        body: JSON.stringify(template),
      });
      setTemplate(res.template);
      setSavedSnapshot(JSON.stringify(res.template));
      toast({
        title: 'Offer Letter Template Saved',
        description: 'All candidate offer PDFs will automatically use this updated template.',
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Failed to save offer template',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleResetDefault() {
    setSaving(true);
    try {
      const res = await apiRequest<{ template: OfferLetterTemplate }>('/api/templates/offer/reset', {
        method: 'POST',
      });
      setTemplate(res.template);
      setSavedSnapshot(JSON.stringify(res.template));
      setResetOpen(false);
      toast({
        title: 'Template Restored',
        description: 'Restored original BumbleB Trust Engagement Letter template.',
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Reset failed',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  const selectedCandidate = candidates.find((c) => c.id === previewCandidateId) || null;
  const previewFilename = selectedCandidate
    ? sanitizeOfferFilename(selectedCandidate.candidate_name)
    : 'Offer_Letter_Sample_Preview.pdf';

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
        Loading Offer Letter Template Studio...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Offer Letter Template Editor</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Edit letterhead, terms, paragraphs, Founder signature, and footer with instant real A4 Times New Roman PDF preview.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('templates')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <Mail className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Edit Email Message</span>
          </button>
          <button
            type="button"
            onClick={() => setResetOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Default</span>
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSaveTemplate}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>
              {saving ? 'Saving Template...' : hasUnsavedChanges ? 'Save Template Changes*' : 'Save Template'}
            </span>
          </button>
        </div>
      </div>

      {/* Main 2-Column Workspace: LEFT = Full Template Controls | RIGHT = Real Live A4 PDF Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN (6 cols) */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl overflow-hidden">
          {/* Section Tabs */}
          <div className="px-4 pt-3 border-b border-slate-200 bg-[#F7F8FA] flex flex-wrap gap-1.5">
            {[
              { id: 'body' as const, label: 'Body & Terms', icon: FileText },
              { id: 'letterhead' as const, label: 'Letterhead', icon: Building2 },
              { id: 'signature' as const, label: 'Signature & Footer', icon: PenTool },
            ].map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors ${
                    active
                      ? 'bg-white border-[#2563EB] text-[#2563EB]'
                      : 'border-transparent text-slate-600 hover:text-[#10243A]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="p-6 space-y-5">
            {activeTab === 'body' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Document Heading</label>
                    <input
                      type="text"
                      value={template.heading}
                      onChange={(e) => updateField('heading', e.target.value)}
                      placeholder="ENGAGEMENT LETTER"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Greeting Line</label>
                    <input
                      type="text"
                      value={template.greeting}
                      onChange={(e) => updateField('greeting', e.target.value)}
                      placeholder="Greetings from BumbleB Trust - Kalvi40!!"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Contract End Date</label>
                    <input
                      type="text"
                      value={template.contract_end_date}
                      onChange={(e) => updateField('contract_end_date', e.target.value)}
                      placeholder="30.04.2027"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Stipend Clause</label>
                    <input
                      type="text"
                      value={template.stipend_text}
                      onChange={(e) => updateField('stipend_text', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <label className="text-xs font-semibold text-[#10243A]">Offer Letter Body Paragraphs</label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={wrapSelectionBold}
                        title="Make selected text bold (**text**)"
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-[#10243A] bg-[#F7F8FA] hover:bg-slate-200/70 border border-slate-300 rounded"
                      >
                        <Bold className="w-3 h-3" />
                        <span>Bold Selection</span>
                      </button>
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                        <span>Font Size:</span>
                        <select
                          value={template.body_font_size}
                          onChange={(e) => updateField('body_font_size', Number(e.target.value))}
                          className="px-2 py-1 text-[11px] font-mono border border-slate-300 rounded bg-white text-[#10243A]"
                        >
                          {[9.5, 10, 10.5, 11, 11.5, 12].map((sz) => (
                            <option key={sz} value={sz}>
                              {sz} pt
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Clickable Placeholder Chips */}
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {OFFER_TEMPLATE_PLACEHOLDERS.map((ph) => (
                      <button
                        key={ph.key}
                        type="button"
                        onClick={() => insertPlaceholder(ph.key)}
                        title={`Insert ${ph.label}`}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono bg-[#F7F8FA] hover:bg-blue-50 text-[#10243A] hover:text-[#2563EB] border border-slate-200 hover:border-blue-300 rounded transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" />
                        <span>{ph.key}</span>
                      </button>
                    ))}
                  </div>

                  <textarea
                    ref={bodyTextareaRef}
                    rows={16}
                    value={template.body}
                    onChange={(e) => updateField('body', e.target.value)}
                    className="w-full px-3.5 py-3 text-sm leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] font-sans"
                  />
                  <p className="text-[11px] text-slate-500 mt-1.5">
                    Wrap phrases with <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">**double asterisks**</code> for bold text. Leave an empty line between paragraphs.
                  </p>
                </div>
              </>
            )}

            {activeTab === 'letterhead' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Top-Left Name</label>
                    <input
                      type="text"
                      value={template.header_name}
                      onChange={(e) => updateField('header_name', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Top-Left Designation</label>
                    <input
                      type="text"
                      value={template.header_role}
                      onChange={(e) => updateField('header_role', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Center Brand Title</label>
                    <input
                      type="text"
                      value={template.brand_title}
                      onChange={(e) => updateField('brand_title', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Center Brand Subtitle</label>
                    <input
                      type="text"
                      value={template.brand_subtitle}
                      onChange={(e) => updateField('brand_subtitle', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Trust Registration Line</label>
                  <input
                    type="text"
                    value={template.trust_regn}
                    onChange={(e) => updateField('trust_regn', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Registered Trust Address</label>
                  <input
                    type="text"
                    value={template.trust_address}
                    onChange={(e) => updateField('trust_address', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Mobile</label>
                    <input
                      type="text"
                      value={template.trust_mobile}
                      onChange={(e) => updateField('trust_mobile', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">E-mail</label>
                    <input
                      type="text"
                      value={template.trust_email}
                      onChange={(e) => updateField('trust_email', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Web-site</label>
                    <input
                      type="text"
                      value={template.trust_website}
                      onChange={(e) => updateField('trust_website', e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'signature' && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Closing Line</label>
                    <input
                      type="text"
                      value={template.closing}
                      onChange={(e) => updateField('closing', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Signatory Title</label>
                    <input
                      type="text"
                      value={template.signatory_title}
                      onChange={(e) => updateField('signatory_title', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Signatory Organization</label>
                    <input
                      type="text"
                      value={template.signatory_org}
                      onChange={(e) => updateField('signatory_org', e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Footer Website Link 1</label>
                    <input
                      type="text"
                      value={template.footer_left_url}
                      onChange={(e) => updateField('footer_left_url', e.target.value)}
                      placeholder="www.bumbleb.org.in"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#10243A] mb-1">Footer Website Link 2</label>
                    <input
                      type="text"
                      value={template.footer_right_url}
                      onChange={(e) => updateField('footer_right_url', e.target.value)}
                      placeholder="www.kalvi40.com"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-200">
                  <FounderSignatureUploader
                    compact
                    onUpdated={() => setPreviewNonce((n) => n + 1)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN (6 cols): Real Live A4 PDF Preview */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#10243A]">Live A4 PDF Template Preview</h3>
              <p className="text-xs text-slate-500">
                Updates automatically as you edit — rendered with Times New Roman &amp; exact BumbleB Trust layout.
              </p>
            </div>
            {candidates.length > 0 && (
              <select
                value={previewCandidateId}
                onChange={(e) => setPreviewCandidateId(Number(e.target.value))}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white max-w-[220px]"
                aria-label="Preview with candidate"
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.candidate_name} ({c.district})
                  </option>
                ))}
              </select>
            )}
          </div>

          <PdfCanvasViewer
            filename={previewFilename}
            customPdfBytes={previewPdfBytes}
            customLoading={previewLoading}
            onReloadCustom={() => setPreviewNonce((n) => n + 1)}
            heightClassName="h-[840px]"
          />
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        variant="danger"
        title="Reset Offer Letter Template to Default?"
        description="This restores the original BumbleB Trust Engagement Letter letterhead, terms, paragraphs, signatory lines, and footer links."
        confirmLabel="Reset to Default"
        loading={saving}
        onConfirm={handleResetDefault}
        onCancel={() => setResetOpen(false)}
      />
    </div>
  );
}
