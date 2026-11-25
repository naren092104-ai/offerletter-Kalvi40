import React, { useState } from 'react';
import { Lock, Mail, ArrowLeft, CheckCircle2, AlertCircle, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { apiRequest, setAuthToken } from '../../lib/api';
import type { AdminUser } from '../../types/kalvi40';

interface AuthViewProps {
  initialResetToken?: string;
  onAuthenticated: (admin: AdminUser) => void;
}

export function AuthView({ initialResetToken = '', onAuthenticated }: AuthViewProps) {
  const rememberedEmail = localStorage.getItem('adminEmail') || '';
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>(initialResetToken ? 'reset' : 'login');
  const [email, setEmail] = useState(rememberedEmail);
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedEmail));
  const [passwordVisible, setPasswordVisible] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; admin: AdminUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAuthToken(res.token, rememberMe);
      onAuthenticated(res.admin);
      if (rememberMe) {
        localStorage.setItem('adminEmail', email);
        localStorage.removeItem('adminPassword');
      } else {
        localStorage.removeItem('adminEmail');
        localStorage.removeItem('adminPassword');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request password reset.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken, newPassword }),
      });
      setNotice(res.message);
      setPassword('');
      setMode('login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] flex flex-col lg:flex-row">
      {/* Left Institutional Panel */}
      <div className="lg:w-[44%] bg-[#10243A] text-white p-8 lg:p-14 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3.5">
            <img
              src="/assets/aistudio/unnamed_4b5dc694.png"
              alt="Kalvi40 Emblem"
              referrerPolicy="no-referrer"
              className="w-11 h-11 rounded-full bg-white p-0.5 object-contain"
            />
            <div>
              <div className="text-lg font-bold tracking-tight">KALVI40</div>
              <div className="text-xs text-slate-300">BumbleB Trust · Chennai</div>
            </div>
          </div>

          <div className="mt-14 max-w-md">
            <h1 className="text-3xl font-bold tracking-tight leading-tight">
              Teaching Coordinator Appointment & Offer Automation
            </h1>
            <p className="mt-4 text-sm text-slate-300 leading-relaxed">
              Generate verified BumbleB Trust Engagement Letters, manage Excel candidate imports, configure CC
              governance, and dispatch personalized offer letters securely.
            </p>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-white/15 space-y-2 text-xs text-slate-300">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#16A36A] shrink-0" />
            <span>Pre-dispatch verification checks DB, Email & PDF binary parity</span>
          </div>
          <div className="text-slate-400">BumbleB Trust · No.63, 2nd Main Road, Sithalapakkam, Chennai - 600126</div>
        </div>
      </div>

      {/* Right Authentication Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
          {mode === 'login' && (
            <>
              <div className="mb-6">
                <h2 className="text-xl font-bold text-[#10243A]">Administrator Sign In</h2>
                <p className="text-sm text-slate-500 mt-1">Sign in to manage candidates, offer PDFs, and campaigns.</p>
              </div>

              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC4545] flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {notice && (
                <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-[#16A36A] flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{notice}</span>
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1.5">Administrator Email</label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                      placeholder="Enter your administrator email"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-semibold text-[#10243A]">Password</label>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setMode('forgot');
                      }}
                      className="text-xs font-medium text-[#2563EB] hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={passwordVisible ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                      placeholder="Enter your password"
                    />
                    <button
                      type="button"
                      onClick={() => setPasswordVisible((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                    >
                      {passwordVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="rememberMe"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 text-[#2563EB] rounded focus:ring-2 focus:ring-[#2563EB] focus:ring-opacity-50"
                  />
                  <label htmlFor="rememberMe" className="text-sm text-slate-500 cursor-pointer">
                    Remember me
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
                >
                  {loading ? 'Signing in...' : 'Sign In'}
                </button>
              </form>

              <div className="mt-6 pt-5 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <p>Use your administrator account credentials.</p>
              </div>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-[#10243A] mb-4"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Sign In</span>
              </button>
              <h2 className="text-xl font-bold text-[#10243A]">Forgot Password</h2>
              <p className="text-sm text-slate-500 mt-1 mb-5">
                Enter your administrator email to generate a time-limited reset token.
              </p>

              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC4545]">{error}</div>
              )}
              {notice && (
                <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-[#16A36A] space-y-2">
                  <div>{notice}</div>
                </div>
              )}

              <form onSubmit={handleForgot} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1.5">Administrator Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
                >
                  {loading ? 'Requesting Reset...' : 'Send Reset Instructions'}
                </button>
              </form>
            </>
          )}

          {mode === 'reset' && (
            <>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-[#10243A] mb-4"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Sign In</span>
              </button>
              <h2 className="text-xl font-bold text-[#10243A]">Reset Password</h2>
              <p className="text-sm text-slate-500 mt-1 mb-5">Enter your reset token and choose a new password.</p>

              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC4545]">{error}</div>
              )}

              <form onSubmit={handleReset} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1.5">Reset Token</label>
                  <input
                    type="text"
                    required
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#10243A] mb-1.5">New Password (min 8 chars)</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
                >
                  {loading ? 'Updating Password...' : 'Reset Password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
