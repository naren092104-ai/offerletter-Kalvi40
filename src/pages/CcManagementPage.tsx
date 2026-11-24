import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, Check, X } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import type { CcRecipient } from '../types/kalvi40';

export function CcManagementPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<CcRecipient[]>([]);
  const [loading, setLoading] = useState(true);

  const [newEmail, setNewEmail] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDefault, setNewDefault] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CcRecipient | null>(null);

  async function loadCc() {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: CcRecipient[] }>('/api/cc');
      setItems(res.items);
    } catch (err) {
      toast({ title: 'Unable to load CC list', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCc();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest('/api/cc', {
        method: 'POST',
        body: JSON.stringify({ email: newEmail, label: newLabel, is_default: newDefault }),
      });
      setNewEmail('');
      setNewLabel('');
      toast({ title: 'CC recipient added', variant: 'success' });
      await loadCc();
    } catch (err) {
      toast({ title: 'Unable to add CC address', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleField(item: CcRecipient, field: 'enabled' | 'is_default') {
    try {
      await apiRequest(`/api/cc/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: !item[field] }),
      });
      await loadCc();
    } catch (err) {
      toast({ title: 'Update failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  async function saveEdit(id: number) {
    try {
      await apiRequest(`/api/cc/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ email: editEmail, label: editLabel }),
      });
      setEditingId(null);
      toast({ title: 'CC recipient updated', variant: 'success' });
      await loadCc();
    } catch (err) {
      toast({ title: 'Update failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await apiRequest(`/api/cc/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      toast({ title: 'CC recipient deleted', variant: 'success' });
      await loadCc();
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-[#10243A] tracking-tight">CC Management</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Configure administrative CC recipients automatically copied on individual offer letter dispatches.
        </p>
      </div>

      {/* Privacy Guarantee Notice */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-start gap-3 text-xs text-slate-600">
        <ShieldCheck className="w-4 h-4 text-[#16A36A] shrink-0 mt-0.5" />
        <div>
          <strong className="text-[#10243A]">Candidate Isolation Enforced:</strong> Every candidate always receives a
          separate individual email. Only the enabled CC addresses below are included in the CC header — candidate email
          addresses are never shared or exposed to one another.
        </div>
      </div>

      {/* Add New CC Form */}
      <form onSubmit={handleAdd} className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[#10243A] mb-3">Add CC Recipient</h3>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5">
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Email Address</label>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="coordinator@bumbleb.org.in"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
            />
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Role / Label</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Accounts & Admin"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
            />
          </div>
          <div className="md:col-span-3 flex items-center justify-between gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 whitespace-nowrap">
              <input type="checkbox" checked={newDefault} onChange={(e) => setNewDefault(e.target.checked)} />
              <span>Default CC</span>
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>Add CC</span>
            </button>
          </div>
        </div>
      </form>

      {/* CC Recipients Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-[#F7F8FA] border-b border-slate-200 text-[11px] font-semibold text-slate-500">
              <th className="py-3 px-4">CC Email Address</th>
              <th className="py-3 px-4">Label / Role</th>
              <th className="py-3 px-4">Enabled</th>
              <th className="py-3 px-4">Default on Campaigns</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">
                  Loading CC configuration...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">
                  No CC recipients configured yet.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4 font-mono text-[#10243A]">
                    {editingId === item.id ? (
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="px-2 py-1 border border-slate-300 rounded w-60 text-xs font-mono"
                      />
                    ) : (
                      item.email
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-700">
                    {editingId === item.id ? (
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="px-2 py-1 border border-slate-300 rounded w-48 text-xs"
                      />
                    ) : (
                      item.label || '—'
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <button
                      type="button"
                      onClick={() => toggleField(item, 'enabled')}
                      className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                        item.enabled
                          ? 'bg-emerald-50 text-[#16A36A] border border-emerald-200'
                          : 'bg-slate-100 text-slate-500 border border-slate-200'
                      }`}
                    >
                      {item.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="py-3 px-4">
                    <input
                      type="checkbox"
                      checked={Boolean(item.is_default)}
                      onChange={() => toggleField(item, 'is_default')}
                      aria-label="Default CC toggle"
                    />
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap space-x-1">
                    {editingId === item.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveEdit(item.id)}
                          className="p-1.5 text-[#16A36A] hover:bg-emerald-50 rounded"
                          title="Save"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="p-1.5 text-slate-500 hover:bg-slate-100 rounded"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditEmail(item.email);
                            setEditLabel(item.label);
                          }}
                          className="p-1.5 text-slate-500 hover:text-[#2563EB] hover:bg-blue-50 rounded"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(item)}
                          className="p-1.5 text-slate-500 hover:text-[#DC4545] hover:bg-red-50 rounded"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        variant="danger"
        title="Remove CC Recipient"
        description={deleteTarget ? `Remove ${deleteTarget.email} from the CC list?` : ''}
        confirmLabel="Remove"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
