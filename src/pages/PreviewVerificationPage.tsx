import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  ShieldCheck,
  FileDown,
  Send,
  Pencil,
  Mail,
  RefreshCw,
  Paperclip,
  AlertTriangle,
  FileEdit,
  PenTool,
} from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PdfCanvasViewer } from '../components/pdf/PdfCanvasViewer';
import { OfferContentEditorModal } from '../components/offers/OfferContentEditorModal';
import { FounderSignatureModal } from '../components/offers/FounderSignatureUploader';
import { sanitizeOfferFilename } from '../types/kalvi40';
import type { NavPageId } from '../components/layout/Sidebar';
import type {
  Candidate,
  CandidateVerificationResult,
  CcRecipient,
  EmailConfigPublic,
} from '../types/kalvi40';

interface PreviewVerificationPageProps {
  initialCandidateId?: number;
  onNavigate: (page: NavPageId) => void;
}

export function PreviewVerificationPage({ initialCandidateId, onNavigate }: PreviewVerificationPageProps) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | ''>(initialCandidateId ?? '');
  const [allEnabledCcs, setAllEnabledCcs] = useState<CcRecipient[]>([]);
  const [selectedCcEmails, setSelectedCcEmails] = useState<string[]>([]);
  const [emailConfig, setEmailConfig] = useState<EmailConfigPublic | null>(null);

  const [verification, setVerification] = useState<CandidateVerificationResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [pdfNonce, setPdfNonce] = useState(1);

  const [sending, setSending] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [resendConfirmOpen, setResendConfirmOpen] = useState(false);
  const [offerEditorOpen, setOfferEditorOpen] = useState(false);
  const [signatureModalOpen, setSignatureModalOpen] = useState(false);

  useEffect(() => {
    async function loadInitial() {
      try {
        const [candRes, ccRes, cfgRes] = await Promise.all([
          apiRequest<{ items: Candidate[] }>('/api/candidates?all=true'),
          apiRequest<{ items: CcRecipient[] }>('/api/cc'),
          apiRequest<{ config: EmailConfigPublic }>('/api/settings/email'),
        ]);
        setCandidates(candRes.items);
        const enabledCcs = ccRes.items.filter((c) => Boolean(c.enabled));
        setAllEnabledCcs(enabledCcs);
        setSelectedCcEmails(enabledCcs.filter((c) => Boolean(c.is_default)).map((c) => c.email));
        setEmailConfig(cfgRes.config);

        if (initialCandidateId && candRes.items.some((c) => c.id === initialCandidateId)) {
          setSelectedId(initialCandidateId);
        } else if (candRes.items.length > 0) {
          setSelectedId(candRes.items[0].id);
        }
      } catch (err) {
        toast({ title: 'Load failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
      }
    }
    void loadInitial();
  }, [initialCandidateId]);

  async function runVerification(candidateId: number) {
    setVerifying(true);
    try {
      const res = await apiRequest<CandidateVerificationResult>(`/api/candidates/${candidateId}/verify`);
      setVerification(res);
      setPdfNonce((n) => n + 1);
    } catch (err) {
      toast({ title: 'Verification error', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setVerifying(false);
    }
  }

  useEffect(() => {
    if (typeof selectedId === 'number') {
      void runVerification(selectedId);
    }
  }, [selectedId]);

  const selectedCandidate = candidates.find((c) => c.id === selectedId) || null;
  const ccEmails = selectedCcEmails;

  async function handleSendIndividual(allowResend = false) {
    if (!selectedCandidate) return;
    setSending(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/send/individual', {
        method: 'POST',
        body: JSON.stringify({
          candidateId: selectedCandidate.id,
          ccEmails,
          allowResend,
        }),
      });
      setConfirmSendOpen(false);
      setResendConfirmOpen(false);
      toast({ title: 'Individual Offer Sent', description: res.message, variant: 'success' });
      const candRes = await apiRequest<{ items: Candidate[] }>('/api/candidates?all=true');
      setCandidates(candRes.items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      if (msg.includes('already sent') && !allowResend) {
        setConfirmSendOpen(false);
        setResendConfirmOpen(true);
      } else {
        toast({ title: 'Send blocked', description: msg, variant: 'error' });
      }
    } finally {
      setSending(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <h3 className="text-base font-semibold text-[#10243A]">No candidates available to preview</h3>
        <p className="text-xs text-slate-500 mt-1">Add a candidate or import an Excel sheet to preview offer letters.</p>
        <button
          type="button"
          onClick={() => onNavigate('candidates')}
          className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] rounded-lg"
        >
          Go to Candidates
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top Action & Candidate Selector Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="text-xs font-semibold text-[#10243A] whitespace-nowrap">Select Candidate:</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#10243A] min-w-[280px] focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.candidate_name} — {c.district} ({c.email})
              </option>
            ))}
          </select>
        </div>

        {selectedCandidate && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('candidates')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>Edit Candidate</span>
            </button>
            <button
              type="button"
              onClick={() => setOfferEditorOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
              <span>Edit Offer Content</span>
            </button>
            <button
              type="button"
              onClick={() => setSignatureModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <PenTool className="w-3.5 h-3.5 text-[#2563EB]" />
              <span>Founder Signature</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('templates')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <Mail className="w-3.5 h-3.5" />
              <span>Edit Email</span>
            </button>
            <button
              type="button"
              disabled={verifying}
              onClick={() => runVerification(selectedCandidate.id)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${verifying ? 'animate-spin' : ''}`} />
              <span>Verify Details</span>
            </button>
            <button
              type="button"
              onClick={() =>
                void downloadAuthenticatedFile(
                  `/api/candidates/${selectedCandidate.id}/pdf?download=1`,
                  verification?.pdfFilename || sanitizeOfferFilename(selectedCandidate.candidate_name)
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>Download PDF</span>
            </button>
            <button
              type="button"
              disabled={!verification?.valid || !emailConfig?.provider_configured}
              onClick={() => setConfirmSendOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-45"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Individual Offer</span>
            </button>
          </div>
        )}
      </div>

      {emailConfig && !emailConfig.provider_configured && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2 text-slate-700">
            <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0" />
            <span>Configure SMTP credentials in Email Configuration to enable "Send Individual Offer".</span>
          </div>
          <button type="button" onClick={() => onNavigate('email-config')} className="font-semibold text-[#2563EB] hover:underline whitespace-nowrap">
            Email Settings
          </button>
        </div>
      )}

      {/* Two-Column Split: LEFT = Email Preview + Verification Checks | RIGHT = Actual PDF Preview */}
      {selectedCandidate && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
          {/* LEFT COLUMN: EMAIL PREVIEW + VERIFICATION AUDIT */}
          <div className="space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#10243A]">Email Preview</h3>
                <span className="text-xs text-slate-500">Individual isolated email</span>
              </div>

              <div className="bg-[#F7F8FA] px-5 py-3.5 border-b border-slate-200 text-xs space-y-1.5">
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">From:</span>
                  <span className="text-[#10243A] font-medium">
                    {emailConfig ? `${emailConfig.sender_name} <${emailConfig.sender_email}>` : 'BumbleB Trust - Kalvi40'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">To:</span>
                  <span className="font-mono text-[#10243A]">
                    {selectedCandidate.candidate_name} &lt;{selectedCandidate.email}&gt;
                  </span>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="text-slate-500 w-20 shrink-0 pt-0.5">CC:</span>
                  {allEnabledCcs.length === 0 ? (
                    <span className="font-mono text-slate-500">No CC configured</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allEnabledCcs.map((cc) => {
                        const checked = selectedCcEmails.includes(cc.email);
                        return (
                          <label
                            key={cc.id}
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono cursor-pointer transition-colors ${
                              checked
                                ? 'bg-blue-50 border-blue-200 text-[#10243A]'
                                : 'bg-white border-slate-200 text-slate-400'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedCcEmails((prev) => [...prev, cc.email]);
                                } else {
                                  setSelectedCcEmails((prev) => prev.filter((item) => item !== cc.email));
                                }
                              }}
                            />
                            <span>{cc.email}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Subject:</span>
                  <span className="font-semibold text-[#10243A]">{verification?.renderedSubject || 'Loading...'}</span>
                </div>
                <div className="flex gap-2 items-center pt-1">
                  <span className="text-slate-500 w-20 shrink-0">Attachment:</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[#2563EB] font-medium">
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>{verification?.pdfFilename || ''}</span>
                  </span>
                </div>
              </div>

              <div className="p-6 text-sm text-[#10243A] whitespace-pre-wrap leading-relaxed">
                {verification?.renderedBody || 'Rendering email content...'}
              </div>
            </div>

            {/* Verification Matrix */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className={`w-4 h-4 ${verification?.valid ? 'text-[#16A36A]' : 'text-[#DC4545]'}`} />
                  <h3 className="text-sm font-semibold text-[#10243A]">Candidate & Document Verification</h3>
                </div>
                <span className={`text-xs font-semibold ${verification?.valid ? 'text-[#16A36A]' : 'text-[#DC4545]'}`}>
                  {verification?.valid ? 'All Checks Passed' : 'Sending Blocked'}
                </span>
              </div>

              <div className="divide-y divide-slate-100">
                {verification?.checks.map((chk) => (
                  <div key={chk.key} className="px-5 py-3 flex items-start gap-3 text-xs">
                    {chk.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-[#16A36A] shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#DC4545] shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className="font-semibold text-[#10243A]">{chk.label}</div>
                      <div className={chk.passed ? 'text-slate-500 mt-0.5' : 'text-[#DC4545] mt-0.5'}>{chk.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: ACTUAL PDF PREVIEW */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-[#10243A]">Actual PDF Preview</h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">
                  {verification?.pdfFilename || sanitizeOfferFilename(selectedCandidate.candidate_name)}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  void downloadAuthenticatedFile(
                    `/api/candidates/${selectedCandidate.id}/pdf?download=1`,
                    verification?.pdfFilename || sanitizeOfferFilename(selectedCandidate.candidate_name)
                  )
                }
                className="text-xs font-semibold text-[#2563EB] hover:underline"
              >
                Download Offer PDF
              </button>
            </div>
            <PdfCanvasViewer
              candidateId={selectedCandidate.id}
              filename={verification?.pdfFilename || sanitizeOfferFilename(selectedCandidate.candidate_name)}
              refreshKey={pdfNonce}
              heightClassName="min-h-[860px]"
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmSendOpen}
        title="Send Individual Offer Letter?"
        description={
          selectedCandidate
            ? `Send personalized appointment offer email with ${verification?.pdfFilename} attached to ${selectedCandidate.candidate_name} (${selectedCandidate.email})?`
            : ''
        }
        confirmLabel="Send Offer Email"
        loading={sending}
        onConfirm={() => handleSendIndividual(false)}
        onCancel={() => setConfirmSendOpen(false)}
      />

      <ConfirmDialog
        open={resendConfirmOpen}
        variant="danger"
        title="Duplicate Send Protection"
        description={
          selectedCandidate
            ? `${selectedCandidate.email} has already received a sent offer email previously. Do you explicitly want to resend another offer email?`
            : ''
        }
        confirmLabel="Confirm Resend"
        loading={sending}
        onConfirm={() => handleSendIndividual(true)}
        onCancel={() => setResendConfirmOpen(false)}
      />

      <OfferContentEditorModal
        open={offerEditorOpen}
        candidate={selectedCandidate}
        onClose={() => setOfferEditorOpen(false)}
        onSaved={async () => {
          const candRes = await apiRequest<{ items: Candidate[] }>('/api/candidates?all=true');
          setCandidates(candRes.items);
          if (selectedCandidate) {
            await runVerification(selectedCandidate.id);
          }
        }}
      />

      <FounderSignatureModal
        open={signatureModalOpen}
        onClose={() => setSignatureModalOpen(false)}
        onUpdated={async () => {
          const candRes = await apiRequest<{ items: Candidate[] }>('/api/candidates?all=true');
          setCandidates(candRes.items);
          if (selectedCandidate) {
            await runVerification(selectedCandidate.id);
          }
        }}
      />
    </div>
  );
}
