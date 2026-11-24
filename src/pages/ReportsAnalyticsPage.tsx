import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiRequest, downloadAuthenticatedFile } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { DeliveryStatusText } from '../components/ui/StatusText';

interface ReportsResponse {
  summary: {
    totalCandidates: number;
    totalOffers: number;
    sentEmails: number;
    failedEmails: number;
    pendingEmails: number;
    successRate: number;
  };
  districtReports: Array<{
    district: string;
    candidates: number;
    offers_generated: number;
    emails_sent: number;
    emails_failed: number;
  }>;
  schoolReports: Array<{
    school_name: string;
    location: string;
    district: string;
    candidates: number;
    offers_generated: number;
    emails_sent: number;
  }>;
  monthlyTrends: Array<{
    month: string;
    candidates_added: number;
    offers_generated: number;
  }>;
  campaignPerformance: Array<{
    id: number;
    batch_code: string;
    name: string;
    total_count: number;
    sent_count: number;
    failed_count: number;
    pending_count: number;
    status: string;
    created_at: string;
  }>;
}

export function ReportsAnalyticsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await apiRequest<ReportsResponse>('/api/reports');
        setData(res);
      } catch (err) {
        toast({ title: 'Unable to load analytics', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading && !data) {
    return <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">Generating analytics report...</div>;
  }

  const s = data?.summary ?? {
    totalCandidates: 0,
    totalOffers: 0,
    sentEmails: 0,
    failedEmails: 0,
    pendingEmails: 0,
    successRate: 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Reports & Analytics</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            District-wise, school-wise, monthly trends, and campaign performance reporting.
          </p>
        </div>

        <button
          type="button"
          onClick={() => downloadAuthenticatedFile('/api/reports/export', 'Kalvi40_Analytics_Report.xlsx')}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Multi-Sheet Excel (.xlsx)</span>
        </button>
      </div>

      {/* Summary KPIs */}
      <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs text-slate-500">Total Offers Generated</div>
          <div className="text-2xl font-bold text-[#10243A] tabular-nums mt-1">{s.totalOffers}</div>
        </div>
        <div className="p-5">
          <div className="text-xs text-slate-500">Email Success Rate</div>
          <div className="text-2xl font-bold text-[#16A36A] tabular-nums mt-1">{s.successRate}%</div>
        </div>
        <div className="p-5">
          <div className="text-xs text-slate-500">Emails Sent</div>
          <div className="text-2xl font-bold text-[#10243A] tabular-nums mt-1">{s.sentEmails}</div>
        </div>
        <div className="p-5">
          <div className="text-xs text-slate-500">Pending Emails</div>
          <div className="text-2xl font-bold text-[#D97706] tabular-nums mt-1">{s.pendingEmails}</div>
        </div>
        <div className="p-5">
          <div className="text-xs text-slate-500">Failed Emails</div>
          <div className="text-2xl font-bold text-[#DC4545] tabular-nums mt-1">{s.failedEmails}</div>
        </div>
      </div>

      {/* District Chart & Monthly Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-[#10243A] mb-4">District-wise Placement & Offer Coverage</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.districtReports || []} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="district" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip />
                <Bar dataKey="candidates" name="Candidates" fill="#10243A" radius={[4, 4, 0, 0]} />
                <Bar dataKey="emails_sent" name="Emails Sent" fill="#16A36A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-[#10243A] mb-4">Monthly Intake & Offer Generation Trends</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.monthlyTrends || []} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip />
                <Bar dataKey="candidates_added" name="Candidates Added" fill="#2563EB" radius={[4, 4, 0, 0]} />
                <Bar dataKey="offers_generated" name="PDFs Generated" fill="#10243A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* District & School Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-[#10243A]">District-wise Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                  <th className="py-2.5 px-4">District</th>
                  <th className="py-2.5 px-4 text-right">Candidates</th>
                  <th className="py-2.5 px-4 text-right">PDFs Ready</th>
                  <th className="py-2.5 px-4 text-right">Sent</th>
                  <th className="py-2.5 px-4 text-right">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data?.districtReports.map((d) => (
                  <tr key={d.district}>
                    <td className="py-2.5 px-4 font-semibold text-[#10243A]">{d.district}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{d.candidates}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{d.offers_generated}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#16A36A]">{d.emails_sent}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#DC4545]">{d.emails_failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-[#10243A]">School-wise Breakdown</h3>
          </div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                <tr>
                  <th className="py-2.5 px-4">School Name</th>
                  <th className="py-2.5 px-4">District</th>
                  <th className="py-2.5 px-4 text-right">Candidates</th>
                  <th className="py-2.5 px-4 text-right">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data?.schoolReports.map((sc) => (
                  <tr key={`${sc.school_name}-${sc.location}`}>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-[#10243A]">{sc.school_name}</div>
                      <div className="text-[11px] text-slate-500">{sc.location}</div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{sc.district}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{sc.candidates}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#16A36A]">{sc.emails_sent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Campaign Performance */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-[#10243A]">Campaign Performance</h3>
        </div>
        {data && data.campaignPerformance.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] text-slate-500">
                  <th className="py-2.5 px-4">Batch Code</th>
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 px-4 text-right">Total</th>
                  <th className="py-2.5 px-4 text-right">Sent</th>
                  <th className="py-2.5 px-4 text-right">Failed</th>
                  <th className="py-2.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.campaignPerformance.map((cp) => (
                  <tr key={cp.id}>
                    <td className="py-2.5 px-4 font-mono text-[#10243A]">{cp.batch_code}</td>
                    <td className="py-2.5 px-4 font-medium text-[#10243A]">{cp.name}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{cp.total_count}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#16A36A]">{cp.sent_count}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-[#DC4545]">{cp.failed_count}</td>
                    <td className="py-2.5 px-4">
                      <DeliveryStatusText status={cp.status === 'completed' ? 'sent' : cp.status === 'completed_with_errors' ? 'failed' : 'processing'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center text-xs text-slate-500">No campaign batches executed yet.</div>
        )}
      </div>
    </div>
  );
}
