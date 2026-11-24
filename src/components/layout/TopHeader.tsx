import { Menu, LogOut, Send } from 'lucide-react';
import { NAV_GROUPS, type NavPageId } from './Sidebar';
import type { AdminUser } from '../../types/kalvi40';

interface TopHeaderProps {
  activePage: NavPageId;
  admin: AdminUser;
  onOpenMobileMenu: () => void;
  onNavigate: (page: NavPageId) => void;
  onLogout: () => void;
}

export function TopHeader({ activePage, admin, onOpenMobileMenu, onNavigate, onLogout }: TopHeaderProps) {
  let groupLabel = 'Workspace';
  let pageLabel = 'Dashboard';
  for (const g of NAV_GROUPS) {
    const found = g.items.find((i) => i.id === activePage);
    if (found) {
      groupLabel = g.label;
      pageLabel = found.label;
      break;
    }
  }

  return (
    <header className="sticky top-0 z-20 h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
          aria-label="Open navigation"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 hidden sm:inline whitespace-nowrap">Kalvi40</span>
          <span className="text-slate-300 hidden sm:inline">/</span>
          <span className="text-slate-500 hidden md:inline whitespace-nowrap">{groupLabel}</span>
          <span className="text-slate-300 hidden md:inline">/</span>
          <h1 className="font-semibold text-[#10243A] truncate">{pageLabel}</h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={() => onNavigate('campaigns')}
          className="hidden sm:inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send Bulk Offers</span>
        </button>

        <div className="h-5 w-px bg-slate-200 hidden sm:block" />

        <button
          type="button"
          onClick={() => onNavigate('profile')}
          className="flex items-center gap-2.5 text-left px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-[#10243A] text-white text-xs font-semibold flex items-center justify-center shrink-0">
            {admin.name
              .split(' ')
              .map((p) => p[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div className="hidden md:block leading-tight">
            <div className="text-xs font-semibold text-[#10243A] whitespace-nowrap">{admin.name}</div>
            <div className="text-[11px] text-slate-500 whitespace-nowrap">{admin.role}</div>
          </div>
        </button>

        <button
          type="button"
          onClick={onLogout}
          title="Sign Out"
          aria-label="Sign Out"
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 text-slate-600 hover:text-[#DC4545] hover:border-red-200 hover:bg-red-50/40 transition-colors shrink-0"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
