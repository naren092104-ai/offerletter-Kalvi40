import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileDown,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile } from '../../lib/api';
import { useToast } from '../ui/Toast';
import {
  sanitizeOfferFilename,
  type Candidate,
  type CandidateVerificationResult,
  type CcRecipient,
  type EmailConfigPublic,
} from '../../types/kalvi40';

interface SendIndividualOfferModalProps {
  candidate: Candidate | null;
  onClose: () => void;
  onSent?: () => void;
}

export function SendIndividualOfferModal({
  candidate,
  onClose,
  onSent,
}: SendIndividualOfferModalProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [verification, setVerification] = useState<CandidateVerificationResult | null>(null);
  const [ccRecipients, setCcRecipients] = useState<CcRecipient[]>([]);
  const [selectedCcEmails, setSelectedCcEmails] = useState<string[]>([]);
  const [emailConfig, setEmailConfig] = useState<EmailConfigPublic | null>(null);
  const [allowResend, setAllowResend] = useState(false);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);

  async function loadDetails(target: Candidate) {
    setLoading(true);
    setDuplicateNotice(null);
    setAllowResend(false);
    try {
      const [verRes, ccRes, cfgRes] = await Promise.all([
        apiRequest<CandidateVerificationResult>(`/api/candidates/${target.id}/verify`),
        apiRequest<{ items: CcRecipient[] }>('/api/cc'),
        apiRequest<{ config: EmailConfigPublic }>('/api/settings/email'),
      ]);
      setVerification(verRes);
      setCcRecipients(ccRes.items.filter((c) => Boolean(c.enabled)));
      setSelectedCcEmails(ccRes.items.filter((c) => Boolean(c.enabled) && Boolean(c.is_default)).map((c) => c.email));
      setEmailConfig(cfgRes.config);
    } catch (err) {
      toast({
        title: 'Unable to prepare offer email',
        description: err instanceof Error ? err.message : 'Verification failed.',
        variant: 'error',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!candidate) return;
    void loadDetails(candidate);
  }, [candidate]);

  if (!candidate) return null;

  const alreadySentBefore = candidate.last_send_status === 'sent' || Boolean(duplicateNotice);
  const pdfFilename = verification?.pdfFilename || sanitizeOfferFilename(candidate.candidate_name);
  const canSend =
    !loading &&
    !sending &&
    Boolean(verification?.valid) &&
    Boolean(emailConfig?.provider_configured) &&
    (!alreadySentBefore || allowResend);

  async function handleSendNow() {
    if (!candidate) return;
    setSending(true);
    setDuplicateNotice(null);
    try {
      const res = await apiRequest<{ message: string }>('/api/send/individual', {
        method: 'POST',
        body: JSON.stringify({
          candidateId: candidate.id,
          ccEmails: selectedCcEmails,
          allowResend,
        }),
      });
      toast({
        title: 'Offer Email Sent',
        description: res.message,
        variant: 'success',
      });
      onSent?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to send offer email.';
      if (msg.toLowerCase().includes('already sent')) {
        setDuplicateNotice(msg);
      } else {
        toast({
          title: 'Send failed',
          description: msg,
          variant: 'error',
        });
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Send className="w-4 h-4 text-[#2563EB]" />
            <div>
              <h3 className="text-base font-semibold text-[#10243A]">Send Individual Offer Letter</h3>
              <p className="text-xs text-slate-500">
                Dispatches one personalized email directly to {candidate.candidate_name}.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
            aria-label="Close send modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto text-xs">
          {/* Candidate Summary */}
          <div className="bg-[#F7F8FA] border border-slate-200 rounded-lg p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[#10243A]">{candidate.candidate_name}</div>
                <div className="font-mono text-[#2563EB] mt-0.5">{candidate.email}</div>
              </div>
              <button
                type="button"
                onClick={() =>
                  void downloadAuthenticatedFile(`/api/candidates/${candidate.id}/pdf?download=1`, pdfFilename)
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-[#10243A] bg-white border border-slate-300 rounded-md hover:bg-slate-50 shrink-0"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>Download PDF</span>
              </button>
            </div>
            <div className="text-slate-600 pt-1 border-t border-slate-200/80">
              <span className="font-medium text-[#10243A]">School:</span> {candidate.school_name}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
              <span>
                <span className="font-medium text-[#10243A]">Location:</span> {candidate.location}, {candidate.district}
              </span>
              <span className="font-mono">Joining: {candidate.joining_date}</span>
            </div>
            <div className="flex items-center gap-1.5 pt-1 text-[#2563EB] font-mono">
              <Paperclip className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{pdfFilename}</span>
            </div>
          </div>

          {/* SMTP Check */}
          {emailConfig && !emailConfig.provider_configured && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 flex items-center justify-between gap-3 text-[#DC4545]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>SMTP credentials are not configured yet. Configure Gmail/SMTP before sending.</span>
              </div>
            </div>
          )}

          {/* Verification Status */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 bg-[#F7F8FA] border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-[#10243A]">
                <ShieldCheck
                  className={`w-4 h-4 ${
                    loading ? 'text-slate-400' : verification?.valid ? 'text-[#16A36A]' : 'text-[#DC4545]'
                  }`}
                />
                <span>Pre-Send Verification</span>
              </div>
              <div className="flex items-center gap-2">
                {!loading && verification && (
                  <span className={`font-semibold ${verification.valid ? 'text-[#16A36A]' : 'text-[#DC4545]'}`}>
                    {verification.valid ? 'All Checks Passed' : `${verification.issues.length} Issue(s) Found`}
                  </span>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadDetails(candidate)}
                  className="text-slate-500 hover:text-[#10243A] p-1"
                  title="Re-run verification"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="p-4 text-center text-slate-500">Generating & verifying personalized PDF...</div>
            ) : verification ? (
              <div className="divide-y divide-slate-100 max-h-40 overflow-y-auto">
                {verification.checks.map((chk) => (
                  <div key={chk.key} className="px-4 py-2 flex items-start gap-2">
                    {chk.passed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#16A36A] shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-[#DC4545] shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <span className="font-semibold text-[#10243A]">{chk.label}: </span>
                      <span className={chk.passed ? 'text-slate-600' : 'text-[#DC4545]'}>{chk.message}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* CC Recipients Selection */}
          <div>
            <div className="font-semibold text-[#10243A] mb-1.5">CC Recipients</div>
            {ccRecipients.length === 0 ? (
              <div className="text-slate-500 bg-[#F7F8FA] border border-slate-200 rounded-lg px-3.5 py-2.5">
                No enabled CC recipients configured.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {ccRecipients.map((cc) => {
                  const checked = selectedCcEmails.includes(cc.email);
                  return (
                    <label
                      key={cc.id}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-slate-200 bg-[#F7F8FA] cursor-pointer hover:bg-slate-100/70"
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
                      <span className="font-mono text-[11px] text-[#10243A]">{cc.email}</span>
                      {cc.label && <span className="text-[11px] text-slate-500 truncate">({cc.label})</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Duplicate Resend Confirmation */}
          {alreadySentBefore && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 space-y-2 text-amber-900">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Duplicate Send Protection</div>
                  <p className="text-[11px] text-amber-800 mt-0.5">
                    {duplicateNotice ||
                      `An offer email was already sent to ${candidate.email}. Check the box below if you want to resend their updated offer letter.`}
                  </p>
                </div>
              </div>
              <label className="inline-flex items-center gap-2 font-semibold text-[#10243A] cursor-pointer pl-6">
                <input
                  type="checkbox"
                  checked={allowResend}
                  onChange={(e) => setAllowResend(e.target.checked)}
                />
                <span>Allow resending offer email to {candidate.email}</span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-[#F7F8FA] border-t border-slate-200 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={handleSendNow}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-45"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{sending ? 'Sending Offer...' : alreadySentBefore ? 'Resend Offer Email' : 'Send Offer Email'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
