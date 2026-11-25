import { useEffect, useState } from 'react';
import { apiRequest, getAuthToken, registerUnauthorizedHandler, setAuthToken } from './lib/api';
import { ToastProvider } from './components/ui/Toast';
import { Sidebar, type NavPageId } from './components/layout/Sidebar';
import { TopHeader } from './components/layout/TopHeader';
import { AuthView } from './components/auth/AuthView';
import { DashboardPage } from './pages/DashboardPage';
import { CandidatesPage } from './pages/CandidatesPage';
import { BulkImportPage } from './pages/BulkImportPage';
import { OfferLettersPage } from './pages/OfferLettersPage';
import { OfferTemplatePage } from './pages/OfferTemplatePage';
import { EmailCampaignsPage } from './pages/EmailCampaignsPage';
import { EmailTemplatesPage } from './pages/EmailTemplatesPage';
import { CcManagementPage } from './pages/CcManagementPage';
import { PreviewVerificationPage } from './pages/PreviewVerificationPage';
import { SendingHistoryPage } from './pages/SendingHistoryPage';
import { ReportsAnalyticsPage } from './pages/ReportsAnalyticsPage';
import { ActivityLogsPage } from './pages/ActivityLogsPage';
import { GeneralSettingsPage } from './pages/GeneralSettingsPage';
import { AdminProfilePage } from './pages/AdminProfilePage';
import { UserManagementPage } from './pages/UserManagementPage';
import type { AdminUser } from './types/kalvi40';

interface NavContext {
  candidateId?: number;
  selectedIds?: number[];
  openAddCandidate?: boolean;
}

function Kalvi40Shell() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [activePage, setActivePage] = useState<NavPageId>('dashboard');
  const [navContext, setNavContext] = useState<NavContext>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const initialResetToken = new URLSearchParams(window.location.search).get('resetToken') || '';

  useEffect(() => {
    registerUnauthorizedHandler(() => {
      setAdmin(null);
    });

    async function verifySession() {
      const token = getAuthToken();
      if (!token) {
        setCheckingAuth(false);
        return;
      }
      try {
        const res = await apiRequest<{ admin: AdminUser }>('/api/auth/me');
        setAdmin(res.admin);
      } catch {
        setAuthToken(null);
        setAdmin(null);
      } finally {
        setCheckingAuth(false);
      }
    }
    void verifySession();
  }, []);

  function handleNavigate(page: NavPageId, context: NavContext = {}) {
    setNavContext(context);
    setActivePage(page);
  }

  function handleLogout() {
    setAuthToken(null);
    setAdmin(null);
    setActivePage('dashboard');
  }

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center text-sm text-slate-500">
        Verifying administrator session...
      </div>
    );
  }

  if (!admin) {
    return <AuthView initialResetToken={initialResetToken} onAuthenticated={setAdmin} />;
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] flex">
      <Sidebar
        activePage={activePage}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileMenuOpen}
        onSelectPage={(page) => handleNavigate(page)}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopHeader
          activePage={activePage}
          admin={admin}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onNavigate={(page) => handleNavigate(page)}
          onLogout={handleLogout}
        />

        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activePage === 'dashboard' && <DashboardPage onNavigate={handleNavigate} />}
          {activePage === 'candidates' && (
            <CandidatesPage openAddOnMount={Boolean(navContext.openAddCandidate)} onNavigate={handleNavigate} />
          )}
          {activePage === 'bulk-import' && <BulkImportPage onNavigate={handleNavigate} />}
          {activePage === 'offer-letters' && <OfferLettersPage onNavigate={handleNavigate} />}
          {activePage === 'offer-template' && <OfferTemplatePage onNavigate={handleNavigate} />}
          {activePage === 'campaigns' && (
            <EmailCampaignsPage initialSelectedIds={navContext.selectedIds} onNavigate={handleNavigate} />
          )}
          {activePage === 'templates' && <EmailTemplatesPage onNavigate={handleNavigate} />}
          {activePage === 'cc-management' && <CcManagementPage />}
          {activePage === 'preview' && (
            <PreviewVerificationPage initialCandidateId={navContext.candidateId} onNavigate={handleNavigate} />
          )}
          {activePage === 'history' && <SendingHistoryPage />}
          {activePage === 'reports' && <ReportsAnalyticsPage />}
          {activePage === 'logs' && <ActivityLogsPage />}
          {activePage === 'settings' && <GeneralSettingsPage />}
          {activePage === 'user-management' && <UserManagementPage currentAdmin={admin} />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Kalvi40Shell />
    </ToastProvider>
  );
}
