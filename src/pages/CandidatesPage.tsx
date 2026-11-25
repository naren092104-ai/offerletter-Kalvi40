import React, { useEffect, useState } from 'react';
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Eye,
  FileDown,
  FileCheck2,
  ArrowUpDown,
  X,
  Send,
  FileEdit,
} from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DeliveryStatusText, PdfStatusText } from '../components/ui/StatusText';
import { OfferContentEditorModal } from '../components/offers/OfferContentEditorModal';
import { SendIndividualOfferModal } from '../components/offers/SendIndividualOfferModal';
import { sanitizeOfferFilename, type Candidate } from '../types/kalvi40';
import type { NavPageId } from '../components/layout/Sidebar';

interface CandidatesPageProps {
  openAddOnMount?: boolean;
  onNavigate: (page: NavPageId, context?: { candidateId?: number; selectedIds?: number[] }) => void;
}

const EMPTY_FORM = {
  candidate_name: '',
  school_name: '',
  location: '',
  district: '',
  phone: '',
  email: '',
  joining_date: new Date().toLocaleDateString('en-GB').replaceAll('/', '.'),
};

const TODAY_DDMMYYYY = new Date().toLocaleDateString('en-GB').replaceAll('/', '.');

export function CandidatesPage({ openAddOnMount = false, onNavigate }: CandidatesPageProps) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [districts, setDistricts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [districtFilter, setDistrictFilter] = useState('all');
  const [offerFilter, setOfferFilter] = useState('all');
  const [sortBy, setSortBy] = useState('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [formOpen, setFormOpen] = useState(openAddOnMount);
  const [editingCandidate, setEditingCandidate] = useState<Candidate | null>(null);
  const [viewingCandidate, setViewingCandidate] = useState<Candidate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Candidate | null>(null);
  const [bulkDeleteMode, setBulkDeleteMode] = useState<'selected' | 'all' | null>(null);
  const [sendTarget, setSendTarget] = useState<Candidate | null>(null);
  const [offerEditorOpen, setOfferEditorOpen] = useState(false);
  const [offerEditorCandidate, setOfferEditorCandidate] = useState<Candidate | null>(null);
  const [formState, setFormState] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  async function fetchCandidates() {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search,
        district: districtFilter,
        offerStatus: offerFilter,
        sortBy,
        sortDir,
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await apiRequest<{
        items: Candidate[];
        total: number;
        districts: string[];
      }>(`/api/candidates?${params.toString()}`);
      setCandidates(res.items);
      setTotal(res.total);
      setDistricts(res.districts);
    } catch (err) {
      toast({
        title: 'Failed to load candidates',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'error',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchCandidates();
  }, [search, districtFilter, offerFilter, sortBy, sortDir, page]);

  function openCreateModal() {
    setEditingCandidate(null);
    setFormState(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEditModal(c: Candidate) {
    setEditingCandidate(c);
    setFormState({
      candidate_name: c.candidate_name,
      school_name: c.school_name,
      location: c.location,
      district: c.district,
      phone: c.phone,
      email: c.email,
      joining_date: c.joining_date,
    });
    setFormOpen(true);
  }

  async function handleSaveCandidate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingCandidate) {
        await apiRequest(`/api/candidates/${editingCandidate.id}`, {
          method: 'PUT',
          body: JSON.stringify(formState),
        });
        toast({ title: 'Candidate updated', description: `${formState.candidate_name} saved successfully.`, variant: 'success' });
      } else {
        await apiRequest('/api/candidates', {
          method: 'POST',
          body: JSON.stringify(formState),
        });
        toast({ title: 'Candidate added', description: `${formState.candidate_name} added to directory.`, variant: 'success' });
      }
      setFormOpen(false);
      await fetchCandidates();
    } catch (err) {
      toast({
        title: editingCandidate ? 'Update failed' : 'Unable to add candidate',
        description: err instanceof Error ? err.message : 'Validation failed.',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCandidate() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/candidates/${deleteTarget.id}`, { method: 'DELETE' });
      toast({ title: 'Candidate deleted', description: `${deleteTarget.candidate_name} removed.`, variant: 'success' });
      setDeleteTarget(null);
      setSelectedIds((prev) => prev.filter((id) => id !== deleteTarget.id));
      await fetchCandidates();
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkDelete() {
    if (!bulkDeleteMode) return;
    setSaving(true);
    try {
      const payload =
        bulkDeleteMode === 'all' ? { deleteAll: true } : { candidateIds: selectedIds };
      const res = await apiRequest<{ deletedCount: number }>('/api/candidates/bulk-delete', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast({
        title: 'Candidates Removed',
        description: `Removed ${res.deletedCount} candidate record(s) and cleaned up generated PDFs.`,
        variant: 'success',
      });
      setBulkDeleteMode(null);
      setSelectedIds([]);
      setPage(1);
      await fetchCandidates();
    } catch (err) {
      toast({ title: 'Bulk delete failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleGeneratePdf(c: Candidate) {
    try {
      const res = await apiRequest<{ filename: string }>(`/api/candidates/${c.id}/generate-pdf`, { method: 'POST' });
      toast({ title: 'PDF Generated', description: res.filename, variant: 'success' });
      await fetchCandidates();
    } catch (err) {
      toast({ title: 'PDF Generation Failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  function toggleSort(col: string) {
    if (sortBy === col) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  }

  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(candidates.map((c) => c.id));
    } else {
      setSelectedIds([]);
    }
  }

  function toggleSelectOne(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const singleSelectedCandidate =
    selectedIds.length === 1 ? candidates.find((c) => c.id === selectedIds[0]) || null : null;

  return (
    <div className="space-y-5">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Candidate Directory</h2>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {total} total Teaching Coordinator candidate{total === 1 ? '' : 's'} registered.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {singleSelectedCandidate && (
            <button
              type="button"
              onClick={() => setSendTarget(singleSelectedCandidate)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Selected Individual</span>
            </button>
          )}
          {selectedIds.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => onNavigate('campaigns', { selectedIds })}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#10243A] hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Create Campaign ({selectedIds.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setBulkDeleteMode('selected')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#DC4545] bg-white border border-red-200 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Selected ({selectedIds.length})</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setOfferEditorCandidate(null);
              setOfferEditorOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Edit Offer Content</span>
          </button>
          {total > 0 && (
            <button
              type="button"
              onClick={() => setBulkDeleteMode('all')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#DC4545] bg-white border border-slate-300 hover:border-red-300 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove All</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('bulk-import')}
            className="px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            Bulk Excel Import
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>Add Candidate</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
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
            placeholder="Search by candidate name, school, location, district, or email..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          />
        </div>

        <select
          value={districtFilter}
          onChange={(e) => {
            setDistrictFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#10243A] focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          aria-label="Filter by district"
        >
          <option value="all">All Districts</option>
          {districts.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        <select
          value={offerFilter}
          onChange={(e) => {
            setOfferFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#10243A] focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
          aria-label="Filter by PDF status"
        >
          <option value="all">All PDF Statuses</option>
          <option value="generated">PDF Generated</option>
          <option value="pending">Pending PDF</option>
        </select>
      </div>

      {/* Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-[#F7F8FA] text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    checked={candidates.length > 0 && candidates.every((c) => selectedIds.includes(c.id))}
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                    aria-label="Select all visible candidates"
                  />
                </th>
                <th className="py-3 px-4">
                  <button type="button" onClick={() => toggleSort('candidate_name')} className="inline-flex items-center gap-1 hover:text-[#10243A]">
                    <span>Candidate Name</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-3 px-4">
                  <button type="button" onClick={() => toggleSort('school_name')} className="inline-flex items-center gap-1 hover:text-[#10243A]">
                    <span>School & Location</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-3 px-4">
                  <button type="button" onClick={() => toggleSort('district')} className="inline-flex items-center gap-1 hover:text-[#10243A]">
                    <span>District</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-3 px-4">Phone Number</th>
                <th className="py-3 px-4">Email Address</th>
                <th className="py-3 px-4">
                  <button type="button" onClick={() => toggleSort('joining_date')} className="inline-flex items-center gap-1 hover:text-[#10243A]">
                    <span>Joining Date</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-3 px-4">PDF Status</th>
                <th className="py-3 px-4">Email Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading && candidates.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    Loading candidate records...
                  </td>
                </tr>
              ) : candidates.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center">
                    <p className="text-sm font-semibold text-[#10243A]">No candidates match your filters</p>
                    <p className="text-xs text-slate-500 mt-1">Add a candidate manually or import an Excel sheet.</p>
                    <button
                      type="button"
                      onClick={openCreateModal}
                      className="mt-3 px-3.5 py-2 text-xs font-semibold text-white bg-[#2563EB] rounded-lg"
                    >
                      Add First Candidate
                    </button>
                  </td>
                </tr>
              ) : (
                candidates.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(c.id)}
                        onChange={() => toggleSelectOne(c.id)}
                        aria-label={`Select ${c.candidate_name}`}
                      />
                    </td>
                    <td className="py-3 px-4 font-semibold text-[#10243A] whitespace-nowrap">
                      <div>{c.candidate_name}</div>
                      {c.custom_offer_body?.trim() && (
                        <div className="text-[10px] font-medium text-[#2563EB]">Custom offer content</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-700 max-w-[240px]">
                      <div className="truncate font-medium" title={c.school_name}>{c.school_name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{c.location}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-700 whitespace-nowrap">{c.district}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-700 whitespace-nowrap">{c.phone || '-'}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-700 whitespace-nowrap">{c.email}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">{c.joining_date}</td>
                    <td className="py-3 px-4">
                      <PdfStatusText generated={c.offer_generated} />
                    </td>
                    <td className="py-3 px-4">
                      <DeliveryStatusText status={c.last_send_status} />
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSendTarget(c)}
                          title="Send Individual Offer Email"
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded"
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
                          title="Edit Offer Content"
                          className="p-1.5 text-slate-500 hover:text-[#2563EB] hover:bg-blue-50 rounded"
                        >
                          <FileEdit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onNavigate('preview', { candidateId: c.id })}
                          title="Preview Email & PDF"
                          className="p-1.5 text-slate-500 hover:text-[#2563EB] hover:bg-blue-50 rounded"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGeneratePdf(c)}
                          title="Generate PDF"
                          className="p-1.5 text-slate-500 hover:text-[#16A36A] hover:bg-emerald-50 rounded"
                        >
                          <FileCheck2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadAuthenticatedFile(
                              `/api/candidates/${c.id}/pdf?download=1`,
                              c.offer_filename || sanitizeOfferFilename(c.candidate_name)
                            )
                          }
                          title="Download PDF"
                          className="p-1.5 text-slate-500 hover:text-[#10243A] hover:bg-slate-100 rounded"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewingCandidate(c)}
                          title="View Details"
                          className="p-1.5 text-slate-500 hover:text-[#10243A] hover:bg-slate-100 rounded text-[11px] font-medium px-2"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(c)}
                          title="Edit Candidate"
                          className="p-1.5 text-slate-500 hover:text-[#2563EB] hover:bg-blue-50 rounded"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(c)}
                          title="Delete Candidate"
                          className="p-1.5 text-slate-500 hover:text-[#DC4545] hover:bg-red-50 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-3 border-t border-slate-200 bg-[#F7F8FA] flex items-center justify-between text-xs text-slate-600">
          <div className="tabular-nums">
            Showing page {page} of {totalPages} ({total} records)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Add / Edit Candidate Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-lg w-full overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-[#10243A]">
                {editingCandidate ? 'Edit Candidate' : 'Add New Candidate'}
              </h3>
              <button type="button" onClick={() => setFormOpen(false)} className="text-slate-400 hover:text-slate-600 p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveCandidate} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#10243A] mb-1">Candidate Name</label>
                <input
                  type="text"
                  required
                  value={formState.candidate_name}
                  onChange={(e) => setFormState({ ...formState, candidate_name: e.target.value })}
                  placeholder="e.g. E Sathiya Kaviya"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#10243A] mb-1">School Name(s)</label>
                <textarea
                  rows={2}
                  required
                  value={formState.school_name}
                  onChange={(e) => setFormState({ ...formState, school_name: e.target.value })}
                  placeholder="Enter any school name format — e.g. PUPS Kadaladi, GHS (Aided) & Unit-2, or multiple schools on separate lines"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Free-form entry supported: enter single or multiple schools, abbreviations, commas, &amp;, slashes, or parentheses in any format.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Location</label>
                  <input
                    type="text"
                    required
                    value={formState.location}
                    onChange={(e) => setFormState({ ...formState, location: e.target.value })}
                    placeholder="e.g. Pattiyandal"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">District</label>
                  <input
                    type="text"
                    required
                    value={formState.district}
                    onChange={(e) => setFormState({ ...formState, district: e.target.value })}
                    placeholder="e.g. Tiruvannamalai"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Phone Number</label>
                  <input
                    type="text"
                    required
                    value={formState.phone}
                    onChange={(e) => setFormState({ ...formState, phone: e.target.value })}
                    placeholder="e.g. 9876543210"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    value={formState.email}
                    onChange={(e) => setFormState({ ...formState, email: e.target.value })}
                    placeholder="candidate@gmail.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1">Joining Date</label>
                  <input
                    type="date"
                    required
                    value={/^\d{2}\.\d{2}\.\d{4}$/.test(formState.joining_date)
                      ? `${formState.joining_date.slice(6, 10)}-${formState.joining_date.slice(3, 5)}-${formState.joining_date.slice(0, 2)}`
                      : formState.joining_date}
                    onChange={(e) => {
                      const [year, month, day] = e.target.value.split('-');
                      setFormState({ ...formState, joining_date: year && month && day ? `${day}.${month}.${year}` : '' });
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingCandidate ? 'Save Changes' : 'Add Candidate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Candidate Details Drawer/Modal */}
      {viewingCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-lg w-full overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-[#10243A]">Candidate Details</h3>
              <button type="button" onClick={() => setViewingCandidate(null)} className="text-slate-400 hover:text-slate-600 p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Candidate Name</span>
                <span className="col-span-2 font-semibold text-[#10243A]">{viewingCandidate.candidate_name}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">School Name</span>
                <span className="col-span-2 text-[#10243A]">{viewingCandidate.school_name}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Location</span>
                <span className="col-span-2 text-[#10243A]">{viewingCandidate.location}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">District</span>
                <span className="col-span-2 text-[#10243A]">{viewingCandidate.district}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Phone Number</span>
                <span className="col-span-2 font-mono text-xs text-[#10243A]">{viewingCandidate.phone || '-'}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Email Address</span>
                <span className="col-span-2 font-mono text-xs text-[#2563EB]">{viewingCandidate.email}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Joining Date</span>
                <span className="col-span-2 font-mono text-[#10243A]">{viewingCandidate.joining_date}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 py-1.5">
                <span className="text-slate-500">PDF Status</span>
                <span className="col-span-2">
                  <PdfStatusText generated={viewingCandidate.offer_generated} />
                </span>
              </div>
            </div>
            <div className="px-6 py-4 bg-[#F7F8FA] border-t border-slate-200 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const target = viewingCandidate;
                  setViewingCandidate(null);
                  setOfferEditorCandidate(target);
                  setOfferEditorOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>Edit Offer Content</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = viewingCandidate;
                  setViewingCandidate(null);
                  setSendTarget(target);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send Offer</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = viewingCandidate.id;
                  setViewingCandidate(null);
                  onNavigate('preview', { candidateId: id });
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg"
              >
                Preview Email & PDF
              </button>
              <button
                type="button"
                onClick={() => setViewingCandidate(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        variant="danger"
        title="Delete Candidate Record"
        description={
          deleteTarget
            ? `Are you sure you want to permanently remove ${deleteTarget.candidate_name} (${deleteTarget.email})? Generated offer PDFs for this candidate will also be removed.`
            : ''
        }
        confirmLabel="Delete Candidate"
        loading={saving}
        onConfirm={handleDeleteCandidate}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(bulkDeleteMode)}
        variant="danger"
        title={bulkDeleteMode === 'all' ? 'Remove All Candidates' : `Delete ${selectedIds.length} Selected Candidate(s)`}
        description={
          bulkDeleteMode === 'all'
            ? `Are you sure you want to permanently remove all ${total} candidate records and their generated offer letter PDFs?`
            : `Are you sure you want to permanently remove the ${selectedIds.length} selected candidate(s) and their generated offer letter PDFs?`
        }
        confirmLabel={bulkDeleteMode === 'all' ? 'Remove All Candidates' : 'Delete Selected'}
        loading={saving}
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkDeleteMode(null)}
      />

      <OfferContentEditorModal
        open={offerEditorOpen}
        candidate={offerEditorCandidate}
        onClose={() => setOfferEditorOpen(false)}
        onSaved={() => void fetchCandidates()}
      />

      <SendIndividualOfferModal
        candidate={sendTarget}
        onClose={() => setSendTarget(null)}
        onSent={() => void fetchCandidates()}
      />
    </div>
  );
}
