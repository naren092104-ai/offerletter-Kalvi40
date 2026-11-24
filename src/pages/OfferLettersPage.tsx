import { useEffect, useState } from 'react';
import { FileCheck2, FileDown, FileEdit, Eye, PenTool, RefreshCw, Search, Send, X } from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { PdfStatusText } from '../components/ui/StatusText';
import { PdfCanvasViewer } from '../components/pdf/PdfCanvasViewer';
import { OfferContentEditorModal } from '../components/offers/OfferContentEditorModal';
import { FounderSignatureModal } from '../components/offers/FounderSignatureUploader';
import { SendIndividualOfferModal } from '../components/offers/SendIndividualOfferModal';
import { sanitizeOfferFilename, type Candidate } from '../types/kalvi40';
import type { NavPageId } from '../components/layout/Sidebar';

interface OfferLettersPageProps {
  onNavigate: (page: NavPageId, context?: { candidateId?: number; selectedIds?: number[] }) => void;
}

export function OfferLettersPage({ onNavigate }: OfferLettersPageProps) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [previewCandidate, setPreviewCandidate] = useState<Candidate | null>(null);
  const [pdfRefreshKey, setPdfRefreshKey] = useState(1);
  const [offerEditorOpen, setOfferEditorOpen] = useState(false);
  const [offerEditorCandidate, setOfferEditorCandidate] = useState<Candidate | null>(null);
  const [signatureModalOpen, setSignatureModalOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<Candidate | null>(null);

  async function loadCandidates() {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Candidate[] }>('/api/candidates?all=true');
      setCandidates(res.items);
    } catch (err) {
      toast({ title: 'Unable to load candidates', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCandidates();
  }, []);

  const filtered = candidates.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.candidate_name.toLowerCase().includes(q) ||
      c.school_name.toLowerCase().includes(q) ||
      c.district.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    );
  });

  async function handleGenerateBulk(ids: number[]) {
    setBulkGenerating(true);
    try {
      const res = await apiRequest<{ generatedCount: number }>('/api/candidates/bulk-generate-pdfs', {
        method: 'POST',
        body: JSON.stringify({ candidateIds: ids }),
      });
      toast({
        title: 'PDFs Generated',
        description: `Generated ${res.generatedCount} personalized BumbleB Trust offer letter PDF(s).`,
        variant: 'success',
      });
      await loadCandidates();
    } catch (err) {
      toast({ title: 'Bulk PDF generation failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setBulkGenerating(false);
    }
  }

  async function handleGenerateOne(c: Candidate) {
    try {
      const res = await apiRequest<{ filename: string }>(`/api/candidates/${c.id}/generate-pdf`, { method: 'POST' });
      toast({ title: 'Offer PDF Ready', description: res.filename, variant: 'success' });
      await loadCandidates();
    } catch (err) {
      toast({ title: 'PDF generation failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  const missingIds = candidates.filter((c) => !c.offer_generated).map((c) => c.id);
  const singleSelectedCandidate =
    selectedIds.length === 1 ? candidates.find((c) => c.id === selectedIds[0]) || null : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Offer Letter PDF Repository</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Customize offer wording, generate official BumbleB Trust Engagement Letters, and send individually or in bulk.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {singleSelectedCandidate && (
            <button
              type="button"
              onClick={() => setSendTarget(singleSelectedCandidate)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Selected Individual</span>
            </button>
          )}
          {selectedIds.length > 1 && (
            <button
              type="button"
              onClick={() => onNavigate('campaigns', { selectedIds })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Selected ({selectedIds.length})</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setSignatureModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <PenTool className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Founder Signature</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOfferEditorCandidate(null);
              setOfferEditorOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Edit Offer Content</span>
          </button>
          {selectedIds.length > 0 && (
            <button
              type="button"
              disabled={bulkGenerating}
              onClick={() => handleGenerateBulk(selectedIds)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#10243A] hover:bg-slate-800 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              <span>Generate Selected ({selectedIds.length})</span>
            </button>
          )}
          {missingIds.length > 0 && (
            <button
              type="button"
              disabled={bulkGenerating}
              onClick={() => handleGenerateBulk(missingIds)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Generate All Missing ({missingIds.length})</span>
            </button>
          )}
          <button
            type="button"
            disabled={bulkGenerating || candidates.length === 0}
            onClick={() => handleGenerateBulk(candidates.map((c) => c.id))}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <FileCheck2 className="w-3.5 h-3.5" />
            <span>{bulkGenerating ? 'Generating PDFs...' : 'Regenerate All PDFs'}</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search candidate, school, or district..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-[#F7F8FA] text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((c) => selectedIds.includes(c.id))}
                    onChange={(e) => setSelectedIds(e.target.checked ? filtered.map((c) => c.id) : [])}
                    aria-label="Select all"
                  />
                </th>
                <th className="py-3 px-4">Candidate</th>
                <th className="py-3 px-4">School & District</th>
                <th className="py-3 px-4">Joining Date</th>
                <th className="py-3 px-4">PDF Filename</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && candidates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    Loading offer letter status...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    No matching candidates found.
                  </td>
                </tr>
              ) : (
                filtered.map((c) => {
                  const filename = c.offer_filename || sanitizeOfferFilename(c.candidate_name);
                  return (
                    <tr key={c.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(c.id)}
                          onChange={() =>
                            setSelectedIds((prev) =>
                              prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                            )
                          }
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-[#10243A]">{c.candidate_name}</div>
                        <div className="font-mono text-[11px] text-slate-500">{c.email}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">
                        <div className="font-medium truncate max-w-[240px]">{c.school_name}</div>
                        <div className="text-[11px] text-slate-500">
                          {c.location}, {c.district}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">{c.joining_date}</td>
                      <td className="py-3 px-4 font-mono text-[11px] text-[#2563EB] whitespace-nowrap">
                        <div>{filename}</div>
                        {c.custom_offer_body?.trim() && (
                          <div className="font-sans text-[10px] font-medium text-emerald-700">Custom offer content</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <PdfStatusText generated={c.offer_generated} />
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1">
                        <button
                          type="button"
                          onClick={() => setSendTarget(c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-[#2563EB] rounded-md hover:bg-blue-700"
                        >
                          <Send className="w-3 h-3" />
                          <span>Send</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOfferEditorCandidate(c);
                            setOfferEditorOpen(true);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#10243A] bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                        >
                          <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
                          <span>Edit Content</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewCandidate(c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#10243A] bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Preview</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGenerateOne(c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#16A36A] bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>{c.offer_generated ? 'Regenerate' : 'Generate'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadAuthenticatedFile(
                              `/api/candidates/${c.id}/pdf?download=1`,
                              filename
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#2563EB] bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inline PDF Viewer Modal */}
      {previewCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-4xl w-full h-[88vh] flex flex-col overflow-hidden">
            <div className="px-6 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-[#10243A]">
                  {sanitizeOfferFilename(previewCandidate.candidate_name)}
                </h3>
                <p className="text-xs text-slate-500">
                  {previewCandidate.candidate_name} · {previewCandidate.school_name}, {previewCandidate.district}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOfferEditorCandidate(previewCandidate);
                    setOfferEditorOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
                  <span>Edit Offer Content</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = previewCandidate;
                    setPreviewCandidate(null);
                    setSendTarget(target);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#16A36A] rounded-lg hover:bg-emerald-700"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send Offer</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = previewCandidate.id;
                    setPreviewCandidate(null);
                    onNavigate('preview', { candidateId: id });
                  }}
                  className="px-3 py-1.5 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Open Full Verification
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void downloadAuthenticatedFile(
                      `/api/candidates/${previewCandidate.id}/pdf?download=1`,
                      sanitizeOfferFilename(previewCandidate.candidate_name)
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#2563EB] rounded-lg hover:bg-blue-700"
                >
                  <FileDown className="w-3.5 h-3.5" />
                  <span>Download PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewCandidate(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <PdfCanvasViewer
              candidateId={previewCandidate.id}
              filename={sanitizeOfferFilename(previewCandidate.candidate_name)}
              refreshKey={pdfRefreshKey}
              heightClassName="flex-1 min-h-0"
            />
          </div>
        </div>
      )}

      <OfferContentEditorModal
        open={offerEditorOpen}
        candidate={offerEditorCandidate}
        onClose={() => setOfferEditorOpen(false)}
        onSaved={() => {
          setPdfRefreshKey((k) => k + 1);
          void loadCandidates();
        }}
      />

      <FounderSignatureModal
        open={signatureModalOpen}
        onClose={() => setSignatureModalOpen(false)}
        onUpdated={() => {
          setPdfRefreshKey((k) => k + 1);
          void loadCandidates();
        }}
      />

      <SendIndividualOfferModal
        candidate={sendTarget}
        onClose={() => setSendTarget(null)}
        onSent={() => void loadCandidates()}
        onNavigateToEmailConfig={() => onNavigate('email-config')}
      />
    </div>
  );
}
