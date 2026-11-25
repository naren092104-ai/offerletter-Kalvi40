import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, UserRound, KeyRound } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import type { AdminUser } from '../types/kalvi40';

interface UserManagementProps {
  currentAdmin: AdminUser;
}

export function UserManagementPage({ currentAdmin }: UserManagementProps) {
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Administrator');
  const [designation, setDesignation] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: AdminUser[] }>('/api/users');
      setUsers(res.items);
    } catch (err) {
      toast({ title: 'Unable to load users', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadUsers(); }, []);

  function openCreate() {
    setEditing(null);
    setName(''); setEmail(''); setRole('Administrator'); setDesignation(''); setPhone(''); setPassword('');
    setModalOpen(true);
  }

  function openEdit(user: AdminUser) {
    setEditing(user);
    setName(user.name); setEmail(user.email); setRole(user.role); setDesignation(user.designation || ''); setPhone(user.phone || ''); setPassword('');
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, string> = { name, email, role, designation, phone };
      if (password) body.password = password;
      if (!editing) body.password = password;
      const res = editing
        ? await apiRequest<{ item: AdminUser; message: string }>(`/api/users/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiRequest<{ item: AdminUser; message: string }>('/api/users', { method: 'POST', body: JSON.stringify(body) });
      toast({ title: res.message, variant: 'success' });
      setModalOpen(false);
      await loadUsers();
    } catch (err) {
      toast({ title: editing ? 'Unable to update user' : 'Unable to create user', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setSubmitting(true);
    try {
      await apiRequest(`/api/users/${deleteTarget.id}`, { method: 'DELETE' });
      toast({ title: 'Administrator deleted', variant: 'success' });
      setDeleteTarget(null);
      await loadUsers();
    } catch (err) {
      toast({ title: 'Unable to delete user', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">User Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">Create and manage administrator accounts.</p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#2563EB] rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> Add User
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F7F8FA] border-b border-slate-200">
              <tr className="text-left text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">User</th><th className="py-3 px-4">Role</th><th className="py-3 px-4">Designation</th><th className="py-3 px-4">Last Login</th><th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">Loading users...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No administrator users found.</td></tr>
              ) : users.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50/60">
                  <td className="py-3 px-4"><div className="flex items-center gap-3"><div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center"><UserRound className="w-4 h-4 text-slate-600" /></div><div><div className="font-semibold text-[#10243A]">{user.name}</div><div className="text-xs text-slate-500">{user.email}</div></div></div></td>
                  <td className="py-3 px-4"><span className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-[#2563EB]">{user.role}</span></td>
                  <td className="py-3 px-4 text-slate-600">{user.designation || '-'}</td>
                  <td className="py-3 px-4 text-slate-500">{user.last_login_at ? new Date(user.last_login_at).toLocaleString('en-IN') : 'Never'}</td>
                  <td className="py-3 px-4"><div className="flex justify-end gap-1"><button type="button" onClick={() => openEdit(user)} className="p-2 text-slate-500 hover:text-[#2563EB] hover:bg-blue-50 rounded-lg" title="Edit user"><Pencil className="w-4 h-4" /></button>{user.id !== currentAdmin.id && <button type="button" onClick={() => setDeleteTarget(user)} className="p-2 text-slate-500 hover:text-[#DC4545] hover:bg-red-50 rounded-lg" title="Delete user"><Trash2 className="w-4 h-4" /></button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200"><h3 className="text-base font-semibold text-[#10243A]">{editing ? 'Edit User' : 'Add User'}</h3></div>
            <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">Full Name</label><input required value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" /></div>
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">Email</label><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" /></div>
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">Role</label><select value={role} onChange={(e) => setRole(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"><option>Administrator</option><option>Manager</option><option>Coordinator</option><option>Viewer</option></select></div>
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">Designation</label><input value={designation} onChange={(e) => setDesignation(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" /></div>
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" /></div>
              <div><label className="block text-xs font-semibold text-[#10243A] mb-1">{editing ? 'New Password (optional)' : 'Password'}</label><div className="relative"><KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" /><input required={!editing} minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimum 8 characters" className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg" /></div></div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-[#F7F8FA] border-t border-slate-200"><button type="button" onClick={() => setModalOpen(false)} disabled={submitting} className="px-4 py-2 text-sm border border-slate-300 rounded-lg bg-white">Cancel</button><button type="submit" disabled={submitting} className="px-4 py-2 text-sm font-semibold text-white bg-[#2563EB] rounded-lg disabled:opacity-50">{submitting ? 'Saving...' : editing ? 'Save Changes' : 'Create User'}</button></div>
          </form>
        </div>
      )}

      <ConfirmDialog open={Boolean(deleteTarget)} title="Delete Administrator" description={deleteTarget ? `Delete ${deleteTarget.name} (${deleteTarget.email})? This account will lose access immediately.` : undefined} confirmLabel="Delete User" variant="danger" loading={submitting} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
    </div>
  );
}
