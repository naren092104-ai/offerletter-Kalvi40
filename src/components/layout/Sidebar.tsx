import React from 'react';
import {
  LayoutDashboard,
  Users,
  FileSpreadsheet,
  FileText,
  FileEdit,
  Send,
  Mail,
  UsersRound,
  Eye,
  History,
  BarChart3,
  ScrollText,
  Settings,
  UserCog,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';

export type NavPageId =
  | 'dashboard'
  | 'candidates'
  | 'bulk-import'
  | 'offer-letters'
  | 'offer-template'
  | 'campaigns'
  | 'templates'
  | 'cc-management'
  | 'preview'
  | 'history'
  | 'reports'
  | 'logs'
  | 'settings'
  | 'user-management'
  | 'profile';

interface NavGroup {
  label: string;
  items: Array<{
    id: NavPageId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }>;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'candidates', label: 'Candidates', icon: Users },
      { id: 'bulk-import', label: 'Bulk Import', icon: FileSpreadsheet },
      { id: 'offer-letters', label: 'Offer Letters', icon: FileText },
      { id: 'offer-template', label: 'Offer Template', icon: FileEdit },
      { id: 'campaigns', label: 'Email Campaigns', icon: Send },
    ],
  },
  {
    label: 'Communication',
    items: [
      { id: 'templates', label: 'Email Templates', icon: Mail },
      { id: 'cc-management', label: 'CC Management', icon: UsersRound },
      { id: 'preview', label: 'Preview & Verification', icon: Eye },
      { id: 'history', label: 'Sending History', icon: History },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { id: 'reports', label: 'Reports & Analytics', icon: BarChart3 },
      { id: 'logs', label: 'Activity Logs', icon: ScrollText },
    ],
  },
  {
    label: 'Settings',
    items: [
      { id: 'settings', label: 'General Settings', icon: Settings },
      { id: 'user-management', label: 'User Management', icon: UserCog },
      { id: 'profile', label: 'Admin Profile', icon: UserCog },
    ],
  },
];

interface SidebarProps {
  activePage: NavPageId;
  collapsed: boolean;
  mobileOpen: boolean;
  onSelectPage: (page: NavPageId) => void;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}

export function Sidebar({
  activePage,
  collapsed,
  mobileOpen,
  onSelectPage,
  onToggleCollapse,
  onCloseMobile,
}: SidebarProps) {
  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#10243A] text-slate-200 select-none">
      {/* Brand Lockup */}
      <div className={`flex items-center h-16 border-b border-white/10 shrink-0 ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <img
            src="/assets/aistudio/unnamed_4b5dc694.png"
            alt="Kalvi40 emblem"
            referrerPolicy="no-referrer"
            className="w-8 h-8 rounded-full object-cover bg-white shrink-0"
          />
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-bold tracking-tight text-white truncate">KALVI40</div>
              <div className="text-[11px] text-slate-400 truncate">BumbleB Trust</div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden lg:inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-400 hover:text-white hover:bg-white/10"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation Groups */}
      <nav className="flex-1 overflow-y-auto py-4 px-2.5 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2.5 mb-1.5 text-[11px] font-semibold tracking-wide text-slate-400">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onSelectPage(item.id);
                      onCloseMobile();
                    }}
                    title={collapsed ? item.label : undefined}
                    className={`w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors whitespace-nowrap ${
                      collapsed ? 'justify-center' : ''
                    } ${
                      isActive
                        ? 'bg-[#2563EB] text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/8'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );

  return (
    <>
      {/* Desktop Fixed Sidebar */}
      <aside
        className={`hidden lg:block shrink-0 border-r border-slate-200 transition-[width] duration-150 ${
          collapsed ? 'w-[72px]' : 'w-[252px]'
        }`}
      >
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/50" onClick={onCloseMobile} />
          <aside className="relative w-64 max-w-[80vw] h-full z-50">{sidebarContent}</aside>
        </div>
      )}
    </>
  );
}
