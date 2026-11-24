import React, { useEffect, useState } from 'react';
import { Save, CheckCircle2, AlertTriangle, Send, PlugZap } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import type { EmailConfigPublic } from '../types/kalvi40';

export function EmailConfigurationPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<EmailConfigPublic | null>(null);
  const [senderName, setSenderName] = useState('BumbleB Trust - Kalvi40');
  const [senderEmail, setSenderEmail] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [rateLimit, setRateLimit] = useState(45);
  const [maxRetries, setMaxRetries] = useState(3);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  const hostHasEmail = smtpHost.includes('@');

  async function loadConfig() {
    try {
      const res = await apiRequest<{ config: EmailConfigPublic }>('/api/settings/email');
      const c = res.config;
      setConfig(c);
      setSenderName(c.sender_name);
      setSenderEmail(c.sender_email);
      setReplyTo(c.reply_to);
      setSmtpHost(c.smtp_host || 'smtp.gmail.com');
      setSmtpPort(c.smtp_port || '587');
      setSmtpUser(c.smtp_user);
      setSmtpPass(c.smtp_pass_set ? '••••••••' : '');
      setSmtpSecure(c.smtp_secure);
      setRateLimit(c.rate_limit_per_minute);
      setMaxRetries(c.max_retries);
      if (!testRecipient && c.sender_email) {
        setTestRecipient(c.sender_email);
      }
    } catch (err) {
      toast({ title: 'Load failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    }
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  function applyGmailPreset() {
    setSmtpHost('smtp.gmail.com');
    setSmtpPort('587');
    setSmtpSecure(false);
    if (!smtpUser && senderEmail.includes('@')) {
      setSmtpUser(senderEmail);
    } else if (!senderEmail && smtpUser.includes('@')) {
      setSenderEmail(smtpUser);
      if (!replyTo) setReplyTo(smtpUser);
    }
    setTestResult(null);
  }

  async function saveCurrentSettings(): Promise<boolean> {
    if (hostHasEmail) {
      toast({
        title: 'Invalid SMTP Host',
        description: 'Enter a mail server hostname like smtp.gmail.com — not an email address.',
        variant: 'error',
      });
      return false;
    }
    const res = await apiRequest<{ config: EmailConfigPublic }>('/api/settings/email', {
      method: 'PUT',
      body: JSON.stringify({
        email_provider: 'smtp',
        sender_name: senderName,
        sender_email: senderEmail,
        reply_to: replyTo,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_user: smtpUser,
        smtp_pass: smtpPass,
        smtp_secure: smtpSecure,
        rate_limit_per_minute: rateLimit,
        max_retries: maxRetries,
      }),
    });
    setConfig(res.config);
    if (res.config.smtp_pass_set) {
      setSmtpPass('••••••••');
    }
    return true;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTestResult(null);
    try {
      const ok = await saveCurrentSettings();
      if (ok) {
        toast({ title: 'SMTP configuration saved', description: 'Credentials stored securely on backend.', variant: 'success' });
      }
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (hostHasEmail) {
      setTestResult({
        ok: false,
        message: 'Invalid SMTP Host. Use a mail server hostname such as smtp.gmail.com, not an email address.',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await saveCurrentSettings();
      if (!saved) return;
      const res = await apiRequest<{ ok: boolean; accountInfo?: string; error?: string }>(
        '/api/settings/email/test-connection',
        { method: 'POST' }
      );
      setTestResult({ ok: true, message: res.accountInfo || 'SMTP connection verified.' });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'SMTP connection failed.' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSendTestEmail() {
    if (!testRecipient.trim()) return;
    setSendingTest(true);
    try {
      const saved = await saveCurrentSettings();
      if (!saved) return;
      const res = await apiRequest<{ message: string }>('/api/settings/email/send-test', {
        method: 'POST',
        body: JSON.stringify({ toEmail: testRecipient }),
      });
      toast({ title: 'Test Email Sent', description: res.message, variant: 'success' });
    } catch (err) {
      toast({ title: 'Test email failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">SMTP Email Configuration</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Direct SMTP relay configuration for individual and bulk offer dispatches. Passwords remain server-side only.
          </p>
        </div>

        <button
          type="button"
          disabled={testing}
          onClick={handleTestConnection}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <PlugZap className="w-3.5 h-3.5 text-[#2563EB]" />
          <span>{testing ? 'Verifying SMTP...' : 'Save & Test SMTP Connection'}</span>
        </button>
      </div>

      {config && (
        <div
          className={`rounded-xl px-5 py-3.5 border text-xs flex items-center gap-2.5 ${
            config.provider_configured
              ? 'bg-emerald-50 border-emerald-200 text-[#16A36A]'
              : 'bg-amber-50 border-amber-200 text-[#D97706]'
          }`}
        >
          {config.provider_configured ? (
            <>
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                <strong>SMTP Ready:</strong> Connected via {config.smtp_host}:{config.smtp_port} ({config.sender_email}).
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                <strong>SMTP Credentials Required:</strong> Enter your SMTP server details (e.g., smtp.gmail.com) and password below, save, and verify connection.
              </span>
            </>
          )}
        </div>
      )}

      {testResult && (
        <div
          className={`rounded-xl px-5 py-3.5 border text-xs flex items-center gap-2.5 ${
            testResult.ok
              ? 'bg-emerald-50 border-emerald-200 text-[#16A36A]'
              : 'bg-red-50 border-red-200 text-[#DC4545]'
          }`}
        >
          {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-semibold text-[#10243A]">SMTP Relay Credentials</h3>
            <p className="text-xs text-slate-500">All offer letter emails are dispatched exclusively over authenticated SMTP.</p>
          </div>
          <button
            type="button"
            onClick={applyGmailPreset}
            className="px-3 py-1.5 text-xs font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
          >
            Use Gmail SMTP (smtp.gmail.com:587)
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Sender Display Name</label>
            <input
              type="text"
              required
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Sender Email Address</label>
            <input
              type="email"
              required
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              placeholder="name@gmail.com"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Reply-To Address</label>
            <input
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="name@gmail.com"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">SMTP Host</label>
            <input
              type="text"
              required
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com"
              className={`w-full px-3 py-2 text-sm font-mono border rounded-lg ${
                hostHasEmail ? 'border-[#DC4545] bg-red-50/40' : 'border-slate-300'
              }`}
            />
            {hostHasEmail ? (
              <p className="text-[11px] text-[#DC4545] mt-1">
                Enter the mail server hostname (e.g., smtp.gmail.com), not your email address.
              </p>
            ) : (
              <p className="text-[11px] text-slate-500 mt-1">For Gmail accounts, use smtp.gmail.com</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">SMTP Port</label>
            <input
              type="text"
              required
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="587"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
            <p className="text-[11px] text-slate-500 mt-1">587 for STARTTLS (recommended) or 465 for implicit TLS</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">SMTP Username (Email)</label>
            <input
              type="text"
              required
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="name@gmail.com"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">SMTP App Password / Password</label>
            <input
              type="password"
              value={smtpPass}
              onChange={(e) => setSmtpPass(e.target.value)}
              placeholder="16-character Gmail App Password"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Gmail requires a 16-character App Password (spaces are automatically removed).
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
            <span>Use implicit TLS (port 465) — leave unchecked for STARTTLS on port 587</span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-200">
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Rate Limit (Emails / Minute)</label>
            <input
              type="number"
              min={1}
              max={300}
              value={rateLimit}
              onChange={(e) => setRateLimit(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#10243A] mb-1">Automatic Retries on Transient Failures</label>
            <input
              type="number"
              min={0}
              max={5}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="pt-4 border-t border-slate-200 flex justify-end">
          <button
            type="submit"
            disabled={saving || hostHasEmail}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save SMTP Configuration'}</span>
          </button>
        </div>
      </form>

      {/* Send Test Email */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <h3 className="text-sm font-semibold text-[#10243A]">Send Verification Test Email</h3>
        <p className="text-xs text-slate-500">
          Dispatches one real email over SMTP with a sample Offer Letter PDF attachment to verify end-to-end delivery.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            placeholder="your-test-inbox@gmail.com"
            className="flex-1 px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
          />
          <button
            type="button"
            disabled={sendingTest || !testRecipient.trim() || hostHasEmail}
            onClick={handleSendTestEmail}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#10243A] hover:bg-slate-800 rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{sendingTest ? 'Sending Test...' : 'Send Test Email'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
