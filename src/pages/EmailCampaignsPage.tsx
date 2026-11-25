import { useEffect, useMemo, useState } from 'react';
import {
  Send,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  RefreshCw,
  Eye,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DeliveryStatusText } from '../components/ui/StatusText';
import { SendIndividualOfferModal } from '../components/offers/SendIndividualOfferModal';
import type { NavPageId } from '../components/layout/Sidebar';
import type {
  Campaign,
  Candidate,
  CandidateVerificationResult,
  CcRecipient,
  EmailTemplate,
  SendHistoryRecord,
} from '../types/kalvi40';

interface EmailCampaignsPageProps {
  initialSelectedIds?: number[];
  onNavigate: (page: NavPageId, context?: { candidateId?: number }) => void;
}

export function EmailCampaignsPage({ initialSelectedIds = [], onNavigate }: EmailCampaignsPageProps) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [ccRecipients, setCcRecipients] = useState<CcRecipient[]>([]);
  const [template, setTemplate] = useState<EmailTemplate | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  const [campaignName, setCampaignName] = useState(`Kalvi40 Teaching Coordinator Offers — ${new Date().toLocaleDateString('en-IN')}`);
  const [selectedIds, setSelectedIds] = useState<number[]>(initialSelectedIds);
  const [selectedCcEmails, setSelectedCcEmails] = useState<string[]>([]);
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);
  const [search, setSearch] = useState('');
  const [districtFilter, setDistrictFilter] = useState('all');

  const [verifying, setVerifying] = useState(false);
  const [verificationSummary, setVerificationSummary] = useState<{
    total: number;
    validCount: number;
    invalidCount: number;
    results: Array<{ candidate: Candidate; verification: CandidateVerificationResult }>;
  } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [launching, setLaunching] = useState(false);

  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [activeDeliveries, setActiveDeliveries] = useState<SendHistoryRecord[]>([]);
  const [individualSendTarget, setIndividualSendTarget] = useState<Candidate | null>(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [candRes, ccRes, tplRes, campRes, emailCfg] = await Promise.all([
        apiRequest<{ items: Candidate[] }>('/api/candidates?all=true'),
        apiRequest<{ items: CcRecipient[] }>('/api/cc'),
        apiRequest<{ template: EmailTemplate }>('/api/templates/master'),
        apiRequest<{ items: Campaign[] }>('/api/campaigns'),
        apiRequest<{ config: { provider_configured: boolean } }>('/api/settings/email'),
      ]);
      setCandidates(candRes.items);
      setCcRecipients(ccRes.items);
      setSelectedCcEmails(ccRes.items.filter((c) => c.enabled && c.is_default).map((c) => c.email));
      setTemplate(tplRes.template);
      setCampaigns(campRes.items);
      setProviderConfigured(emailCfg.config.provider_configured);

      if (initialSelectedIds.length === 0 && selectedIds.length === 0) {
        const unsent = candRes.items.filter((c) => c.last_send_status !== 'sent').map((c) => c.id);
        setSelectedIds(unsent);
      }

      const running = campRes.items.find((c) => c.status === 'queued' || c.status === 'processing');
      if (running) setActiveCampaignId(running.id);
    } catch (err) {
      toast({ title: 'Unable to load campaign workspace', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  // Poll active campaign progress automatically
  useEffect(() => {
    if (!activeCampaignId) return;
    let active = true;
    async function poll() {
      try {
        const res = await apiRequest<{ campaign: Campaign; deliveries: SendHistoryRecord[] }>(`/api/campaigns/${activeCampaignId}`);
        if (!active) return;
        setActiveCampaign(res.campaign);
        setActiveDeliveries(res.deliveries);
        if (res.campaign.status === 'completed' || res.campaign.status === 'completed_with_errors') {
          const [campRes, candRes] = await Promise.all([
            apiRequest<{ items: Campaign[] }>('/api/campaigns'),
            apiRequest<{ items: Candidate[] }>('/api/candidates?all=true'),
          ]);
          if (active) {
            setCampaigns(campRes.items);
            setCandidates(candRes.items);
          }
        }
      } catch {
        // ignore transient poll errors
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeCampaignId]);

  const districts = useMemo(() => Array.from(new Set(candidates.map((c) => c.district))).sort(), [candidates]);

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selectedIds.includes(c.id)),
    [candidates, selectedIds]
  );

  const duplicateBlockedCandidates = useMemo(
    () =>
      skipAlreadySent
        ? selectedCandidates.filter(
            (c) => c.last_send_status === 'sent' || c.last_send_status === 'pending' || c.last_send_status === 'processing'
          )
        : [],
    [selectedCandidates, skipAlreadySent]
  );

  const eligibleSelectedCount = useMemo(() => {
    const blockedSet = new Set(duplicateBlockedCandidates.map((c) => c.id));
    if (!verificationSummary) {
      return Math.max(0, selectedCandidates.length - blockedSet.size);
    }
    return verificationSummary.results.filter(
      (r) => r.verification.valid && !blockedSet.has(r.candidate.id)
    ).length;
  }, [selectedCandidates, duplicateBlockedCandidates, verificationSummary]);

  const invalidVerificationCount = useMemo(() => {
    if (!verificationSummary) return 0;
    return verificationSummary.invalidCount;
  }, [verificationSummary]);

  const filteredCandidates = useMemo(() => {
    return candidates.filter((c) => {
      if (districtFilter !== 'all' && c.district !== districtFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        c.candidate_name.toLowerCase().includes(q) ||
        c.school_name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.district.toLowerCase().includes(q)
      );
    });
  }, [candidates, districtFilter, search]);

  async function runVerificationAndPrepare() {
    if (selectedIds.length === 0) {
      toast({ title: 'No candidates selected', description: 'Select at least one candidate to verify.', variant: 'warning' });
      return;
    }
    setVerifying(true);
    try {
      const res = await apiRequest<{
        total: number;
        validCount: number;
        invalidCount: number;
        results: Array<{ candidate: Candidate; verification: CandidateVerificationResult }>;
      }>('/api/candidates/verify-batch', {
        method: 'POST',
        body: JSON.stringify({
          candidateIds: selectedIds,
          subject: template?.subject,
          body: template?.body,
        }),
      });
      setVerificationSummary(res);
      toast({
        title: 'Verification Complete',
        description: `${res.validCount} valid, ${res.invalidCount} invalid/blocked.`,
        variant: res.invalidCount === 0 ? 'success' : 'warning',
      });
    } catch (err) {
      toast({ title: 'Verification failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setVerifying(false);
    }
  }

  async function openSendAllConfirmation() {
    if (selectedIds.length === 0) {
      toast({ title: 'No candidates selected', description: 'Select candidates first.', variant: 'warning' });
      return;
    }
    if (!verificationSummary) {
      await runVerificationAndPrepare();
    }
    setConfirmOpen(true);
  }

  async function handleLaunchBulkCampaign() {
    setLaunching(true);
    try {
      const res = await apiRequest<{
        campaign: Campaign;
        queuedCount: number;
        blockedCount: number;
      }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: campaignName,
          candidateIds: selectedIds,
          ccEmails: selectedCcEmails,
          subject: template?.subject,
          body: template?.body,
          skipAlreadySent,
        }),
      });

      setConfirmOpen(false);
      setActiveCampaignId(res.campaign.id);
      setActiveCampaign(res.campaign);
      setVerificationSummary(null);
      if (skipAlreadySent) {
        setSelectedIds((prev) =>
          prev.filter((id) => {
            const c = candidates.find((item) => item.id === id);
            return c && c.last_send_status !== 'sent' && c.last_send_status !== 'pending' && c.last_send_status !== 'processing';
          })
        );
      }
      toast({
        title: `Campaign ${res.campaign.batch_code} Queued`,
        description:
          res.blockedCount > 0
            ? `${res.queuedCount} offer email(s) queued; ${res.blockedCount} duplicate/ineligible skipped.`
            : `${res.queuedCount} individual offer emails queued for background delivery.`,
        variant: 'success',
      });
      await loadAll();
    } catch (err) {
      setConfirmOpen(false);
      toast({
        title: 'Campaign launch blocked',
        description: err instanceof Error ? err.message : 'Unable to start campaign.',
        variant: 'error',
      });
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Bulk Email Campaigns</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Every candidate receives a separate individual email with their own personalized Offer Letter PDF and configured CCs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {selectedCandidates.length === 1 && (
            <button
              type="button"
              disabled={!providerConfigured}
              onClick={() => setIndividualSendTarget(selectedCandidates[0])}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>Send Selected Individual</span>
            </button>
          )}
          <button
            type="button"
            disabled={verifying || selectedIds.length === 0}
            onClick={runVerificationAndPrepare}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <ShieldCheck className="w-4 h-4 text-[#2563EB]" />
            <span>{verifying ? 'Generating PDFs & Verifying...' : `Verify & Generate PDFs (${selectedIds.length})`}</span>
          </button>

          <button
            type="button"
            disabled={selectedIds.length === 0 || !providerConfigured}
            onClick={openSendAllConfirmation}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Send className="w-4 h-4" />
            <span>SEND ALL OFFERS</span>
          </button>
        </div>
      </div>

      {!providerConfigured && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3.5 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 shrink-0 text-[#DC4545]" />
          <span className="text-xs text-[#DC4545]">
            <strong>Bulk sending blocked:</strong> SMTP relay credentials are missing from the backend environment.
          </span>
        </div>
      )}

      {/* Campaign Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Candidate Selection */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#10243A]">1. Select Candidates ({selectedIds.length} selected)</h3>
              <p className="text-xs text-slate-500">Each recipient receives an isolated email without exposing other candidates.</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelectedIds(candidates.filter((c) => c.last_send_status !== 'sent').map((c) => c.id))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md hover:bg-slate-50"
              >
                Select Unsent
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(filteredCandidates.map((c) => c.id))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md hover:bg-slate-50"
              >
                Select All Filtered
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="p-3 border-b border-slate-200 bg-[#F7F8FA] flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter candidates..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
              />
            </div>
            <select
              value={districtFilter}
              onChange={(e) => setDistrictFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
            >
              <option value="all">All Districts</option>
              {districts.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={skipAlreadySent}
                onChange={(e) => setSkipAlreadySent(e.target.checked)}
              />
              <span>Prevent duplicate sending</span>
            </label>
          </div>

          <div className="overflow-y-auto max-h-[380px]">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-white border-b border-slate-200 text-[11px] text-slate-500">
                <tr>
                  <th className="py-2.5 px-4 w-10">Pick</th>
                  <th className="py-2.5 px-4">Candidate & Email</th>
                  <th className="py-2.5 px-4">School & District</th>
                  <th className="py-2.5 px-4">Last Status</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && candidates.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      Loading candidates...
                    </td>
                  </tr>
                ) : (
                  filteredCandidates.map((c) => {
                    const checked = selectedIds.includes(c.id);
                    return (
                      <tr key={c.id} className={checked ? 'bg-blue-50/35' : 'hover:bg-slate-50'}>
                        <td className="py-2.5 px-4">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setVerificationSummary(null);
                              setSelectedIds((prev) => (prev.includes(c.id) ? prev.filter((i) => i !== c.id) : [...prev, c.id]));
                            }}
                          />
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-[#10243A]">{c.candidate_name}</div>
                          <div className="font-mono text-[11px] text-slate-500">{c.email}</div>
                        </td>
                        <td className="py-2.5 px-4 text-slate-700">
                          <div className="truncate max-w-[200px]" title={c.school_name}>{c.school_name}</div>
                          <div className="text-[11px] text-slate-500">{c.district}</div>
                        </td>
                        <td className="py-2.5 px-4">
                          <DeliveryStatusText status={c.last_send_status} />
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setIndividualSendTarget(c)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded"
                            >
                              <Send className="w-3 h-3" />
                              <span>Send Now</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onNavigate('preview', { candidateId: c.id })}
                              className="inline-flex items-center gap-1 text-[#2563EB] hover:underline"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Inspect</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Batch Name, CC Config & Master Template Summary */}
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-[#10243A]">2. Batch & CC Configuration</h3>

            <div>
              <label className="block text-xs font-semibold text-[#10243A] mb-1">Campaign Batch Name</label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-[#10243A]">CC Recipients for This Batch</label>
                <button
                  type="button"
                  onClick={() => onNavigate('cc-management')}
                  className="text-[11px] font-medium text-[#2563EB] hover:underline"
                >
                  Manage CC List
                </button>
              </div>
              {ccRecipients.length === 0 ? (
                <div className="text-xs text-slate-500">No CC addresses configured.</div>
              ) : (
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {ccRecipients.map((cc) => (
                    <label key={cc.id} className="flex items-center gap-2 text-xs p-2 rounded-lg border border-slate-200 bg-[#F7F8FA]">
                      <input
                        type="checkbox"
                        checked={selectedCcEmails.includes(cc.email)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCcEmails((prev) => [...prev, cc.email]);
                          } else {
                            setSelectedCcEmails((prev) => prev.filter((em) => em !== cc.email));
                          }
                        }}
                      />
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-[#10243A] truncate">{cc.email}</div>
                        {cc.label && <div className="text-[10px] text-slate-500 truncate">{cc.label}</div>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-200">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-[#10243A]">Master Email Template</span>
                <button
                  type="button"
                  onClick={() => onNavigate('templates')}
                  className="text-[11px] font-medium text-[#2563EB] hover:underline"
                >
                  Edit Template
                </button>
              </div>
              <div className="text-xs text-slate-600 bg-[#F7F8FA] border border-slate-200 rounded-lg p-2.5">
                <div className="font-semibold text-[#10243A] truncate">{template?.subject}</div>
                <div className="text-[11px] text-slate-500 mt-1 line-clamp-3 whitespace-pre-line">{template?.body}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Verification Gate Results */}
      {verificationSummary && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-[#10243A]">
              Pre-Dispatch Verification Results ({verificationSummary.validCount} Valid · {verificationSummary.invalidCount} Blocked)
            </div>
            <span className="text-xs text-slate-500">Checked DB Name = PDF Content = Email Greeting</span>
          </div>
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                  <th className="py-2 px-4">Candidate</th>
                  <th className="py-2 px-4">Email</th>
                  <th className="py-2 px-4">PDF Attachment</th>
                  <th className="py-2 px-4">Verification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {verificationSummary.results.map(({ candidate, verification }) => (
                  <tr key={candidate.id}>
                    <td className="py-2 px-4 font-semibold text-[#10243A]">{candidate.candidate_name}</td>
                    <td className="py-2 px-4 font-mono text-[11px]">{candidate.email}</td>
                    <td className="py-2 px-4 font-mono text-[11px] text-[#2563EB]">{verification.pdfFilename}</td>
                    <td className="py-2 px-4">
                      {verification.valid ? (
                        <span className="inline-flex items-center gap-1 text-[#16A36A] font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Verified Ready</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[#DC4545] font-medium">
                          <XCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>{verification.issues[0]}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Active Campaign Queue Live Tracker */}
      {activeCampaign && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-[#10243A]">
                  Background Queue Tracker · <span className="font-mono">{activeCampaign.batch_code}</span>
                </h3>
                <DeliveryStatusText
                  status={
                    activeCampaign.status === 'completed'
                      ? 'sent'
                      : activeCampaign.status === 'completed_with_errors'
                      ? 'failed'
                      : 'processing'
                  }
                />
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Server-side queue continues processing even if you navigate away or close your browser.
              </p>
            </div>
            <div className="flex items-center gap-5 text-xs tabular-nums">
              <span>Sent: <strong className="text-[#16A36A]">{activeCampaign.sent_count}</strong></span>
              <span>Pending: <strong className="text-[#D97706]">{activeCampaign.pending_count}</strong></span>
              <span>Failed: <strong className="text-[#DC4545]">{activeCampaign.failed_count}</strong></span>
            </div>
          </div>

          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                  <th className="py-2 px-4">Candidate</th>
                  <th className="py-2 px-4">Email</th>
                  <th className="py-2 px-4">PDF Attachment</th>
                  <th className="py-2 px-4">Status</th>
                  <th className="py-2 px-4">Error / Message ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activeDeliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2 px-4 font-medium text-[#10243A]">{d.candidate_name}</td>
                    <td className="py-2 px-4 font-mono text-[11px]">{d.candidate_email}</td>
                    <td className="py-2 px-4 font-mono text-[11px]">{d.pdf_filename}</td>
                    <td className="py-2 px-4">
                      <DeliveryStatusText status={d.status} />
                    </td>
                    <td className="py-2 px-4 text-[11px] text-slate-500 max-w-xs truncate">
                      {d.error_message || d.provider_message_id || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Past Campaigns Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#10243A]">Campaign Batches</h3>
          <button
            type="button"
            onClick={loadAll}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-[#10243A]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
        {campaigns.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">No bulk campaigns have been created yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                  <th className="py-2.5 px-4">Batch ID</th>
                  <th className="py-2.5 px-4">Campaign Name</th>
                  <th className="py-2.5 px-4 text-right">Valid</th>
                  <th className="py-2.5 px-4 text-right">Sent</th>
                  <th className="py-2.5 px-4 text-right">Failed</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Created</th>
                  <th className="py-2.5 px-4 text-right">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaigns.map((camp) => (
                  <tr key={camp.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono text-[#10243A]">{camp.batch_code}</td>
                    <td className="py-2.5 px-4 font-medium text-[#10243A]">{camp.name}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{camp.valid_count}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#16A36A] font-semibold">{camp.sent_count}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#DC4545] font-semibold">{camp.failed_count}</td>
                    <td className="py-2.5 px-4">
                      <DeliveryStatusText
                        status={camp.status === 'completed' ? 'sent' : camp.status === 'completed_with_errors' ? 'failed' : 'processing'}
                      />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500">
                      {camp.created_at.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => setActiveCampaignId(camp.id)}
                        className="text-xs font-medium text-[#2563EB] hover:underline"
                      >
                        View Queue
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      <ConfirmDialog
        open={confirmOpen}
        title={`You are about to send ${eligibleSelectedCount} individual appointment email${eligibleSelectedCount === 1 ? '' : 's'}.`}
        description="Each candidate will receive an isolated email with only their own personalized Engagement Letter PDF attached."
        confirmLabel="CONFIRM & SEND OFFERS"
        loading={launching}
        confirmDisabled={eligibleSelectedCount === 0}
        onConfirm={handleLaunchBulkCampaign}
        onCancel={() => setConfirmOpen(false)}
      >
        <div className="bg-[#F7F8FA] border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-500">Total Selected Candidates</span>
            <span className="font-semibold text-[#10243A] tabular-nums">{selectedIds.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Eligible & Verified to Send Now</span>
            <span className="font-semibold text-[#16A36A] tabular-nums">{eligibleSelectedCount}</span>
          </div>
          {duplicateBlockedCandidates.length > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">Skipped (Already Sent)</span>
              <span className="font-semibold text-[#D97706] tabular-nums">{duplicateBlockedCandidates.length}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-slate-500">Verification Failed / Blocked</span>
            <span className="font-semibold text-[#DC4545] tabular-nums">{invalidVerificationCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Total PDF Attachments</span>
            <span className="font-semibold text-[#10243A] tabular-nums">{eligibleSelectedCount}</span>
          </div>
          <div className="pt-2 border-t border-slate-200">
            <span className="text-slate-500 block mb-1">CC Recipients</span>
            <span className="font-mono text-[11px] text-[#10243A]">
              {selectedCcEmails.length > 0 ? selectedCcEmails.join(', ') : 'None selected'}
            </span>
          </div>
          {(duplicateBlockedCandidates.length > 0 || !skipAlreadySent) && (
            <div className="pt-2 border-t border-slate-200">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#10243A] cursor-pointer">
                <input
                  type="checkbox"
                  checked={!skipAlreadySent}
                  onChange={(e) => setSkipAlreadySent(!e.target.checked)}
                />
                <span>Allow resending to already-sent candidates</span>
              </label>
            </div>
          )}
        </div>
        {eligibleSelectedCount === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              All selected candidates have already received an offer email. Enable <strong>Allow resending</strong> above
              or select unsent candidates to launch this batch.
            </span>
          </div>
        )}
      </ConfirmDialog>

      <SendIndividualOfferModal
        candidate={individualSendTarget}
        onClose={() => setIndividualSendTarget(null)}
        onSent={() => void loadAll()}
      />
    </div>
  );
}
