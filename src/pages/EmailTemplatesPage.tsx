import { useEffect, useRef, useState } from 'react';
import { Save, RotateCcw, Plus, FileEdit } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { OfferContentEditorModal } from '../components/offers/OfferContentEditorModal';
import type { NavPageId } from '../components/layout/Sidebar';
import {
  TEMPLATE_PLACEHOLDERS,
  renderTemplateString,
  sanitizeOfferFilename,
  type Candidate,
  type EmailTemplate,
} from '../types/kalvi40';

interface EmailTemplatesPageProps {
  onNavigate?: (page: NavPageId) => void;
}

export function EmailTemplatesPage({ onNavigate }: EmailTemplatesPageProps = {}) {
  const { toast } = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [updatedInfo, setUpdatedInfo] = useState<string>('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sampleId, setSampleId] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [offerEditorOpen, setOfferEditorOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [tplRes, candRes] = await Promise.all([
          apiRequest<{ template: EmailTemplate }>('/api/templates/master'),
          apiRequest<{ items: Candidate[] }>('/api/candidates?all=true'),
        ]);
        setSubject(tplRes.template.subject);
        setBody(tplRes.template.body);
        setUpdatedInfo(
          tplRes.template.updated_by
            ? `Last updated by ${tplRes.template.updated_by} on ${tplRes.template.updated_at.slice(0, 16)}`
            : ''
        );
        setCandidates(candRes.items);
        if (candRes.items.length > 0) setSampleId(candRes.items[0].id);
      } catch (err) {
        toast({ title: 'Unable to load master template', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function insertPlaceholder(token: string) {
    const el = bodyRef.current;
    if (!el) {
      setBody((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await apiRequest<{ template: EmailTemplate }>('/api/templates/master', {
        method: 'PUT',
        body: JSON.stringify({ subject, body }),
      });
      setUpdatedInfo(`Last updated by ${res.template.updated_by} on ${res.template.updated_at.slice(0, 16)}`);
      toast({ title: 'Master template saved', description: 'All upcoming emails will use this updated template.', variant: 'success' });
    } catch (err) {
      toast({ title: 'Failed to save template', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      const res = await apiRequest<{ template: EmailTemplate }>('/api/templates/master/reset', { method: 'POST' });
      setSubject(res.template.subject);
      setBody(res.template.body);
      setResetOpen(false);
      toast({ title: 'Template reset', description: 'Restored official Kalvi40 appointment email template.', variant: 'success' });
    } catch (err) {
      toast({ title: 'Reset failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  const sampleCandidate = candidates.find((c) => c.id === sampleId) ?? {
    candidate_name: 'E Sathiya Kaviya',
    school_name: 'Govt Panchayat Union Middle School',
    location: 'Pattiyandal',
    district: 'Tiruvannamalai',
    email: 'kaviya132052@gmail.com',
    joining_date: '21.10.2026',
  };

  if (loading) {
    return <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">Loading master email template...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Master Email Template</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            One fixed master template governs all candidate offer communications unless explicitly updated by an administrator.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => (onNavigate ? onNavigate('offer-template') : setOfferEditorOpen(true))}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <FileEdit className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Edit Offer PDF Template</span>
          </button>
          <button
            type="button"
            onClick={() => setResetOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Default</span>
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save Master Template'}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Editor */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#10243A]">Template Editor</h3>
            {updatedInfo && <span className="text-[11px] text-slate-500">{updatedInfo}</span>}
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1.5">Email Subject Line</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
            />
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label className="text-xs font-semibold text-[#10243A]">Insert Dynamic Placeholder</label>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {TEMPLATE_PLACEHOLDERS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => insertPlaceholder(p.key)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono bg-[#F7F8FA] hover:bg-blue-50 text-[#10243A] hover:text-[#2563EB] border border-slate-300 rounded-md transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>{p.key}</span>
                </button>
              ))}
            </div>
            <textarea
              ref={bodyRef}
              rows={15}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full px-3.5 py-3 text-sm leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] font-sans"
            />
          </div>
        </div>

        {/* Right: Live Preview */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[#10243A]">Live Sample Preview</h3>
            {candidates.length > 0 && (
              <select
                value={sampleId}
                onChange={(e) => setSampleId(Number(e.target.value))}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white max-w-[220px]"
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.candidate_name} ({c.district})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="bg-[#F7F8FA] px-4 py-3 border-b border-slate-200 text-xs space-y-1">
              <div>
                <span className="text-slate-500 inline-block w-16">To:</span>
                <span className="font-mono text-[#10243A]">{sampleCandidate.email}</span>
              </div>
              <div>
                <span className="text-slate-500 inline-block w-16">Subject:</span>
                <span className="font-semibold text-[#10243A]">{renderTemplateString(subject, sampleCandidate)}</span>
              </div>
              <div>
                <span className="text-slate-500 inline-block w-16">Attach:</span>
                <span className="font-mono text-[#2563EB]">{sanitizeOfferFilename(sampleCandidate.candidate_name)}</span>
              </div>
            </div>
            <div className="p-5 text-sm text-[#10243A] whitespace-pre-wrap leading-relaxed min-h-[340px]">
              {renderTemplateString(body, sampleCandidate)}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        variant="danger"
        title="Reset Master Email Template?"
        description="This will overwrite any custom edits with the default Kalvi40 Teaching Coordinator appointment email template."
        confirmLabel="Reset to Default"
        loading={saving}
        onConfirm={handleReset}
        onCancel={() => setResetOpen(false)}
      />

      <OfferContentEditorModal
        open={offerEditorOpen}
        onClose={() => setOfferEditorOpen(false)}
        onSaved={() => {}}
      />
    </div>
  );
}
