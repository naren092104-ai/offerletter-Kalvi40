import { useEffect, useState } from 'react';
import {
  UserPlus,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  Send,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { apiRequest } from '../lib/api';
import { DeliveryStatusText } from '../components/ui/StatusText';
import type { NavPageId } from '../components/layout/Sidebar';
import type { ActivityLog, Campaign } from '../types/kalvi40';

interface DashboardData {
  kpis: {
    totalCandidates: number;
    totalOffersGenerated: number;
    emailsSent: number;
    emailsPending: number;
    emailsFailed: number;
  };
  districtDistribution: Array<{ district: string; count: number; offers_generated: number }>;
  monthlyActivity: Array<{ month: string; sent: number; failed: number; pending: number }>;
  recentActivities: ActivityLog[];
  recentCampaigns: Campaign[];
  providerConfigured: boolean;
}

interface DashboardPageProps {
  onNavigate: (page: NavPageId, context?: { candidateId?: number; openAddCandidate?: boolean }) => void;
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadDashboard() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<DashboardData>('/api/dashboard');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-72 bg-white border border-slate-200 rounded-xl animate-pulse" />
          <div className="h-72 bg-white border border-slate-200 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-[#DC4545]">
        {error}
      </div>
    );
  }

  const kpis = data?.kpis ?? {
    totalCandidates: 0,
    totalOffersGenerated: 0,
    emailsSent: 0,
    emailsPending: 0,
    emailsFailed: 0,
  };

  return (
    <div className="space-y-6">
      {/* Page Intro & Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Executive Operations Overview</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Live candidate records, PDF offer generation, and email campaign dispatch across BumbleB Trust – Kalvi40.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('candidates', { openAddCandidate: true })}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Add Candidate</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('bulk-import')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Upload Excel</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('offer-letters')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Generate Offer</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('campaigns')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Send Bulk Offers</span>
          </button>
        </div>
      </div>

      {/* 5-Column KPI Strip (Single unified container with hairline dividers) */}
      <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Total Candidates</div>
          <div className="mt-2 text-2xl font-bold text-[#10243A] tabular-nums">{kpis.totalCandidates}</div>
          <div className="mt-1 text-xs text-slate-500">Active directory</div>
        </div>
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Total Offers Generated</div>
          <div className="mt-2 text-2xl font-bold text-[#10243A] tabular-nums">{kpis.totalOffersGenerated}</div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {kpis.totalCandidates > 0
              ? `${Math.round((kpis.totalOffersGenerated / kpis.totalCandidates) * 100)}% PDF coverage`
              : '0% PDF coverage'}
          </div>
        </div>
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Emails Sent</div>
          <div className="mt-2 text-2xl font-bold text-[#16A36A] tabular-nums">{kpis.emailsSent}</div>
          <div className="mt-1 text-xs text-slate-500">Accepted by provider</div>
        </div>
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Emails Pending</div>
          <div className="mt-2 text-2xl font-bold text-[#D97706] tabular-nums">{kpis.emailsPending}</div>
          <div className="mt-1 text-xs text-slate-500">Queued for dispatch</div>
        </div>
        <div className="p-5 col-span-2 sm:col-span-1">
          <div className="text-xs font-medium text-slate-500">Emails Failed</div>
          <div className="mt-2 text-2xl font-bold text-[#DC4545] tabular-nums">{kpis.emailsFailed}</div>
          <div className="mt-1 text-xs text-slate-500">Requires review or retry</div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Email Activity */}
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-[#10243A]">Monthly Email Activity</h3>
              <p className="text-xs text-slate-500 mt-0.5">Transactional email dispatches by month</p>
            </div>
            <button
              type="button"
              onClick={loadDashboard}
              className="text-slate-400 hover:text-[#10243A] p-1 rounded"
              title="Refresh metrics"
              aria-label="Refresh metrics"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          {data && data.monthlyActivity.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.monthlyActivity} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="sent" name="Sent" stroke="#16A36A" fill="#16A36A" fillOpacity={0.14} strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#DC4545" fill="#DC4545" fillOpacity={0.1} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-center border border-dashed border-slate-200 rounded-lg px-4">
              <p className="text-sm font-medium text-[#10243A]">No email dispatch activity recorded yet</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                Real monthly counts appear here once you send an individual or bulk offer letter campaign.
              </p>
            </div>
          )}
        </div>

        {/* District-wise Candidate Distribution */}
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-[#10243A]">District-wise Candidate Distribution</h3>
              <p className="text-xs text-slate-500 mt-0.5">Candidates & generated PDFs per district</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-[#2563EB] hover:underline whitespace-nowrap"
            >
              Full Report
            </button>
          </div>

          {data && data.districtDistribution.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.districtDistribution} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="district" tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Candidates" fill="#10243A" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="offers_generated" name="PDFs Generated" fill="#2563EB" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-center border border-dashed border-slate-200 rounded-lg">
              <p className="text-sm font-medium text-[#10243A]">No candidates in directory</p>
              <button
                type="button"
                onClick={() => onNavigate('bulk-import')}
                className="mt-2 text-xs font-semibold text-[#2563EB] hover:underline"
              >
                Import Candidates from Excel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Recent Campaigns & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#10243A]">Recent Campaigns</h3>
            <button
              type="button"
              onClick={() => onNavigate('campaigns')}
              className="text-xs font-medium text-[#2563EB] hover:underline"
            >
              Manage Campaigns
            </button>
          </div>
          {data && data.recentCampaigns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-[#F7F8FA] text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4">Batch ID</th>
                    <th className="py-2.5 px-4">Campaign</th>
                    <th className="py-2.5 px-4 text-right">Sent / Total</th>
                    <th className="py-2.5 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {data.recentCampaigns.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-[#10243A] whitespace-nowrap">{c.batch_code}</td>
                      <td className="py-2.5 px-4 text-slate-700 truncate max-w-[180px]">{c.name}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums font-medium text-[#10243A]">
                        {c.sent_count} / {c.valid_count}
                      </td>
                      <td className="py-2.5 px-4">
                        <DeliveryStatusText status={c.status === 'completed' ? 'sent' : c.status === 'completed_with_errors' ? 'failed' : 'processing'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-[#10243A]">No campaigns launched yet</p>
              <p className="text-xs text-slate-500 mt-1">Create a bulk campaign once candidates and email credentials are ready.</p>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#10243A]">Recent Activity</h3>
            <button
              type="button"
              onClick={() => onNavigate('logs')}
              className="text-xs font-medium text-[#2563EB] hover:underline"
            >
              View All Logs
            </button>
          </div>
          {data && data.recentActivities.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {data.recentActivities.map((log) => (
                <div key={log.id} className="px-6 py-3 flex items-start justify-between gap-4 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-[#10243A] truncate">{log.details}</div>
                    <div className="text-slate-500 mt-0.5 flex items-center gap-1.5">
                      <span>{log.admin_email}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-[11px]">{log.action}</span>
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono tabular-nums whitespace-nowrap shrink-0">
                    {log.created_at.slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-xs text-slate-500">No activity recorded yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
