import { useEffect, useState } from 'react';
import { Search, FileDown, RotateCcw, Download } from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { DeliveryStatusText } from '../components/ui/StatusText';
import type { SendHistoryRecord } from '../types/kalvi40';

export function SendingHistoryPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<SendHistoryRecord[]>([]);
  const [batches, setBatches] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [batchFilter, setBatchFilter] = useState('all');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  async function loadHistory() {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search,
        status: statusFilter,
        batch: batchFilter,
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await apiRequest<{
        items: SendHistoryRecord[];
        total: number;
        batches: string[];
      }>(`/api/history?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
      setBatches(res.batches);
    } catch (err) {
      toast({ title: 'Unable to load history', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, [search, statusFilter, batchFilter, page]);

  async function retryOne(id: number) {
    try {
      await apiRequest(`/api/history/${id}/retry`, { method: 'POST' });
      toast({ title: 'Retry queued', description: 'Email added back to the delivery queue.', variant: 'success' });
      await loadHistory();
    } catch (err) {
      toast({ title: 'Retry failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  async function retryAllFailed() {
    try {
      const res = await apiRequest<{ requeuedCount: number }>('/api/history/retry-batch', {
        method: 'POST',
        body: JSON.stringify({ batchCode: batchFilter === 'all' ? '' : batchFilter }),
      });
      toast({
        title: 'Retries queued',
        description: `${res.requeuedCount} failed email(s) re-queued.`,
        variant: res.requeuedCount > 0 ? 'success' : 'info',
      });
      await loadHistory();
    } catch (err) {
      toast({ title: 'Retry failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Sending History</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Tracks SMTP queue state, relay acceptance, PDF attachments, and error retries.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={retryAllFailed}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retry Failed</span>
          </button>
          <button
            type="button"
            onClick={() =>
              downloadAuthenticatedFile(`/api/history/export?status=${encodeURIComponent(statusFilter)}`, 'Kalvi40_Sending_History.xlsx')
            }
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Excel</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search candidate, email, batch ID, or PDF filename..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
        >
          <option value="all">All Statuses</option>
          <option value="sent">Sent</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </select>
        <select
          value={batchFilter}
          onChange={(e) => {
            setBatchFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
        >
          <option value="all">All Batches</option>
          {batches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-4">Candidate Name</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">CC</th>
                <th className="py-3 px-4">Batch ID</th>
                <th className="py-3 px-4">PDF Filename</th>
                <th className="py-3 px-4">Sending Date</th>
                <th className="py-3 px-4">Queue Status</th>
                <th className="py-3 px-4">Delivery Tracking</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    Loading sending history...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center">
                    <p className="text-sm font-semibold text-[#10243A]">No email dispatches recorded yet</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Individual and bulk offer dispatches will appear here with real provider message IDs and delivery states.
                    </p>
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-semibold text-[#10243A] whitespace-nowrap">{row.candidate_name}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-700 whitespace-nowrap">{row.candidate_email}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500 max-w-[160px] truncate" title={row.cc_emails}>
                      {row.cc_emails || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#10243A] whitespace-nowrap">{row.batch_code}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[#2563EB] whitespace-nowrap">{row.pdf_filename}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-slate-600 whitespace-nowrap">
                      {(row.sent_at || row.created_at).slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-3 px-4">
                      <DeliveryStatusText status={row.status} />
                      {row.error_message && (
                        <div className="text-[11px] text-[#DC4545] max-w-[200px] truncate mt-0.5" title={row.error_message}>
                          {row.error_message}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <DeliveryStatusText status={row.delivery_status} />
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        onClick={() =>
                          void downloadAuthenticatedFile(
                            `/api/candidates/${row.candidate_id}/pdf?download=1`,
                            row.pdf_filename
                          )
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-[#10243A] bg-white border border-slate-300 rounded hover:bg-slate-50"
                      >
                        <FileDown className="w-3 h-3" />
                        <span>PDF</span>
                      </button>
                      {row.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => retryOne(row.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-[#DC4545] bg-red-50 border border-red-200 rounded hover:bg-red-100"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Resend</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-slate-200 bg-[#F7F8FA] flex items-center justify-between text-xs text-slate-600">
          <div className="tabular-nums">
            Page {page} of {totalPages} ({total} records)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded-md disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded-md disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
