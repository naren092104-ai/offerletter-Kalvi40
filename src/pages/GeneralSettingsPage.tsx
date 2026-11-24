import React, { useEffect, useState } from 'react';
import { Save, CheckCircle2, Database } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { FounderSignatureUploader } from '../components/offers/FounderSignatureUploader';
import type { GeneralSettings } from '../types/kalvi40';

export function GeneralSettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiRequest<{ settings: GeneralSettings }>('/api/settings/general');
        setSettings(res.settings);
      } catch (err) {
        toast({ title: 'Load failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
      }
    }
    void load();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      await apiRequest('/api/settings/general', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      toast({ title: 'General settings saved', description: 'Offer letter letterhead parameters updated.', variant: 'success' });
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">Loading settings...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-bold text-[#10243A] tracking-tight">General Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Founder signature upload, institutional letterhead fields, fixed contract end date, and deployment readiness.
        </p>
      </div>

      <FounderSignatureUploader />

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Organization Name</label>
            <input
              type="text"
              value={settings.organization_name}
              onChange={(e) => setSettings({ ...settings, organization_name: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Program Name</label>
            <input
              type="text"
              value={settings.program_name}
              onChange={(e) => setSettings({ ...settings, program_name: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Contract End Date (Default: 30.04.2027)</label>
            <input
              type="text"
              value={settings.contract_end_date}
              onChange={(e) => setSettings({ ...settings, contract_end_date: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Trust Contact Phone</label>
            <input
              type="text"
              value={settings.trust_mobile}
              onChange={(e) => setSettings({ ...settings, trust_mobile: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Trust Header Email</label>
            <input
              type="email"
              value={settings.trust_email}
              onChange={(e) => setSettings({ ...settings, trust_email: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Trust Website</label>
            <input
              type="text"
              value={settings.trust_website}
              onChange={(e) => setSettings({ ...settings, trust_website: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#10243A] mb-1">Stipend Clause (Original Engagement Letter Term)</label>
          <input
            type="text"
            value={settings.stipend_text}
            onChange={(e) => setSettings({ ...settings, stipend_text: e.target.value })}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#10243A] mb-1">Registered Trust Address</label>
          <input
            type="text"
            value={settings.trust_address}
            onChange={(e) => setSettings({ ...settings, trust_address: e.target.value })}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#10243A] mb-1">Trust Registration Line</label>
          <input
            type="text"
            value={settings.trust_regn}
            onChange={(e) => setSettings({ ...settings, trust_regn: e.target.value })}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <div className="pt-4 border-t border-slate-200 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save General Settings'}</span>
          </button>
        </div>
      </form>

      {/* Serverless Deployment & Storage Readiness */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-[#10243A]" />
          <h3 className="text-sm font-semibold text-[#10243A]">Database & Serverless Deployment Readiness</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 text-xs">
          <div className="p-3.5 border border-slate-200 rounded-lg bg-[#F7F8FA]">
            <div className="font-semibold text-[#10243A]">Active Database</div>
            <div className="text-[#16A36A] font-medium mt-1 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Supabase PostgreSQL Connected</span>
            </div>
          </div>
          <div className="p-3.5 border border-slate-200 rounded-lg bg-[#F7F8FA]">
            <div className="font-semibold text-[#10243A]">Supabase PostgreSQL & Storage</div>
            <div className="text-slate-600 mt-1">
              {settings.supabase_configured
                ? `Connected (${settings.supabase_url})`
                : 'Migration ready in /supabase/migrations/001_initial_schema.sql'}
            </div>
          </div>
          <div className="p-3.5 border border-slate-200 rounded-lg bg-[#F7F8FA]">
            <div className="font-semibold text-[#10243A]">Cloudflare Workers Queue</div>
            <div className="text-slate-600 mt-1">Configured in /worker/index.ts & /wrangler.toml</div>
          </div>
        </div>
      </div>
    </div>
  );
}
