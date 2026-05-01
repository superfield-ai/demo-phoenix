import React, { useState, useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import {
  Settings,
  User,
  Users,
  KanbanSquare,
  TrendingUp,
  HelpCircle,
  Briefcase,
  ShieldCheck,
  Activity,
  BarChart2,
  FileBarChart,
} from 'lucide-react';
import { MobileInstallPage } from './pages/mobile-install';
import { SettingsPage } from './pages/settings';
import { LeadDetailPage } from './pages/lead-detail';
import { LeadQueuePage } from './pages/lead-queue';
import { PipelineBoardPage } from './pages/pipeline-board';
import { CfoPortfolioPage } from './pages/cfo-portfolio';
import { CfoDashboardPage } from './pages/cfo-dashboard';
import { CollectionQueuePage } from './pages/collection-queue';
import { CollectionCaseDetailPage } from './pages/collection-case-detail';
import { KycManualReviewPage } from './pages/kyc-manual-review';
import { AccountManagerDashboardPage } from './pages/account-manager-dashboard';
import { CampaignAnalysisPage } from './pages/campaign-analysis';
import { CfoReportsPage } from './pages/cfo-reports';
import { usePlatform } from './hooks/use-platform';
import { deriveDefaultPage } from './lib/default-page';
import type { ActivePage } from './lib/default-page';
import { isDismissalActive, DISMISSED_KEY } from './components/pwa/install-prompt';
import { NotificationBell } from './components/NotificationBell';
import {
  WalkthroughModal,
  SALES_REP_STEPS,
  CFO_STEPS,
  COLLECTIONS_AGENT_STEPS,
  ACCOUNT_MANAGER_STEPS,
  FINANCE_CONTROLLER_STEPS,
  BDM_STEPS,
  resetOnboarding,
} from './components/WalkthroughModal';

/** Returns true when the visitor is on a mobile platform (android or ios) */
function isMobilePlatform(os: string): boolean {
  return os === 'android' || os === 'ios';
}

/**
 * Mobile install gate wrapper.
 *
 * Renders MobileInstallPage for mobile non-standalone visitors who have not
 * already dismissed (within 90 days) or skipped for the session.
 * Falls through to the main app otherwise.
 */
function MobileGate({ children }: { children: React.ReactNode }) {
  const { os, isStandalone } = usePlatform();
  const [sessionSkipped, setSessionSkipped] = useState(false);

  // Check dismissal TTL from localStorage
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISSED_KEY) : null;
  const dismissed = isDismissalActive(stored);

  const shouldShowGate = isMobilePlatform(os) && !isStandalone && !dismissed && !sessionSkipped;

  if (shouldShowGate) {
    return (
      <MobileInstallPage
        onSkip={() => setSessionSkipped(true)}
        onDone={() => {
          // Force re-render — the dismissal or install state has changed.
          // isDismissalActive will re-read localStorage on next render.
          setSessionSkipped(true);
        }}
      />
    );
  }

  return <>{children}</>;
}

/**
 * Determine walkthrough steps for the authenticated user's role.
 * Returns null if no walkthrough applies to the role.
 */
function getWalkthroughSteps(
  role: string | null | undefined,
  isCfo: boolean | undefined,
  isBdm: boolean | undefined,
) {
  if (isCfo || role === 'cfo') return CFO_STEPS;
  if (isBdm || role === 'bdm') return BDM_STEPS;
  if (role === 'sales_rep') return SALES_REP_STEPS;
  if (role === 'collections_agent') return COLLECTIONS_AGENT_STEPS;
  if (role === 'account_manager') return ACCOUNT_MANAGER_STEPS;
  if (role === 'finance_controller') return FINANCE_CONTROLLER_STEPS;
  return null;
}

function App() {
  const { user, logout, loading } = useAuth();
  const isPipelineRole = user?.role === 'sales_rep' || user?.isSuperadmin;
  const defaultPage: ActivePage = deriveDefaultPage(
    user?.role,
    user?.isCfo,
    user?.isBdm,
    user?.isSuperadmin,
  );
  const [activePage, setActivePage] = useState<ActivePage>(defaultPage);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [showWalkthrough, setShowWalkthrough] = useState<boolean | null>(null);

  // Track whether activePage has been seeded from a resolved user.
  // On first mount user is null (auth not yet resolved), so useState above
  // seeds activePage as 'settings'. This ref ensures we re-sync exactly once
  // when the user first transitions from null to a real user object.
  const userResolvedRef = useRef(false);

  // Sync activePage to the role-correct default the first time user resolves.
  useEffect(() => {
    if (!user) return;
    if (userResolvedRef.current) return;
    userResolvedRef.current = true;
    setActivePage(deriveDefaultPage(user.role, user.isCfo, user.isBdm, user.isSuperadmin));
  }, [user]);

  // Determine whether to show the walkthrough once we have user data
  React.useEffect(() => {
    if (!user) return;
    // Show if onboarding is not yet completed
    if (user.onboarding_completed === false) {
      const steps = getWalkthroughSteps(user.role, user.isCfo, user.isBdm);
      if (steps) setShowWalkthrough(true);
    }
  }, [user]);

  async function handleShowTour() {
    if (!user) return;
    await resetOnboarding();
    setShowWalkthrough(true);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const walkthroughSteps = getWalkthroughSteps(user.role, user.isCfo, user.isBdm);

  function renderMain() {
    if (activePage === 'pipeline') {
      if (!isPipelineRole) {
        return <SettingsPage />;
      }
      return <PipelineBoardPage />;
    }
    if (activePage === 'leads') {
      if (!isPipelineRole) {
        return <SettingsPage />;
      }
      if (selectedLeadId) {
        return (
          <LeadDetailPage prospectId={selectedLeadId} onBack={() => setSelectedLeadId(null)} />
        );
      }
      return <LeadQueuePage onSelectLead={(id) => setSelectedLeadId(id)} />;
    }
    if (activePage === 'cfo-portfolio') {
      if (!user?.isCfo && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      return <CfoPortfolioPage />;
    }
    if (activePage === 'cfo-dashboard') {
      if (user?.role !== 'finance_controller' && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      return <CfoDashboardPage />;
    }
    if (activePage === 'collection-queue') {
      if (user?.role !== 'collections_agent' && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      if (selectedCaseId) {
        return (
          <CollectionCaseDetailPage
            caseId={selectedCaseId}
            onBack={() => setSelectedCaseId(null)}
          />
        );
      }
      return <CollectionQueuePage onSelectCase={(id) => setSelectedCaseId(id)} />;
    }
    if (activePage === 'kyc-review') {
      if (user?.role === 'sales_rep') {
        return <SettingsPage />;
      }
      return <KycManualReviewPage />;
    }
    if (activePage === 'account-manager-dashboard') {
      if (user?.role !== 'account_manager' && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      return <AccountManagerDashboardPage />;
    }
    if (activePage === 'campaign-analysis') {
      if (!user?.isBdm && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      return <CampaignAnalysisPage />;
    }
    if (activePage === 'cfo-reports') {
      if (!user?.isCfo && !user?.isSuperadmin) {
        return <SettingsPage />;
      }
      return <CfoReportsPage />;
    }
    return <SettingsPage />;
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-zinc-50 font-sans overflow-hidden text-zinc-900">
      {/* Onboarding walkthrough modal */}
      {showWalkthrough && walkthroughSteps && (
        <WalkthroughModal steps={walkthroughSteps} onClose={() => setShowWalkthrough(false)} />
      )}

      {/* Left Sidebar — visible on md+ */}
      <nav className="hidden md:flex w-16 shrink-0 border-r border-zinc-200 bg-white flex-col items-center py-6 justify-between z-10">
        <div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
            <span className="text-white font-black text-lg">C</span>
          </div>

          <div className="flex flex-col gap-4 mt-4 w-full px-2">
            {isPipelineRole && (
              <button
                title="Pipeline"
                data-testid="nav-pipeline"
                onClick={() => setActivePage('pipeline')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'pipeline'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <KanbanSquare size={20} strokeWidth={2.5} />
              </button>
            )}
            {isPipelineRole && (
              <button
                onClick={() => {
                  setActivePage('leads');
                  setSelectedLeadId(null);
                }}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${activePage === 'leads' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700'}`}
                title="Lead queue"
                data-testid="nav-leads"
              >
                <Users size={20} strokeWidth={2.5} />
              </button>
            )}
            <NotificationBell
              onSelectLead={(prospectId) => {
                setActivePage('leads');
                setSelectedLeadId(prospectId);
              }}
            />
            {(user?.role === 'collections_agent' || user?.isSuperadmin) && (
              <button
                title="Case Queue"
                data-testid="nav-collection-queue"
                onClick={() => {
                  setActivePage('collection-queue');
                  setSelectedCaseId(null);
                }}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'collection-queue'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <Briefcase size={20} strokeWidth={2.5} />
              </button>
            )}
            {(user?.role === 'account_manager' || user?.isSuperadmin) && (
              <button
                title="Customer Health"
                data-testid="nav-account-manager-dashboard"
                onClick={() => setActivePage('account-manager-dashboard')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'account-manager-dashboard'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <Activity size={20} strokeWidth={2.5} />
              </button>
            )}
            {(user?.isBdm || user?.isSuperadmin) && (
              <button
                title="Campaign Analysis"
                data-testid="nav-campaign-analysis"
                onClick={() => setActivePage('campaign-analysis')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'campaign-analysis'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <BarChart2 size={20} strokeWidth={2.5} />
              </button>
            )}
            {(user?.isCfo || user?.isSuperadmin) && (
              <button
                title="CFO Portfolio"
                onClick={() => setActivePage('cfo-portfolio')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'cfo-portfolio'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <TrendingUp size={20} strokeWidth={2.5} />
              </button>
            )}
            {(user?.isCfo || user?.isSuperadmin) && (
              <button
                title="Reports"
                data-testid="nav-cfo-reports"
                onClick={() => setActivePage('cfo-reports')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'cfo-reports'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <FileBarChart size={20} strokeWidth={2.5} />
              </button>
            )}
            {(user?.role === 'finance_controller' || user?.isSuperadmin) && (
              <button
                title="CFO Dashboard"
                data-testid="nav-cfo-dashboard"
                onClick={() => setActivePage('cfo-dashboard')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'cfo-dashboard'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <TrendingUp size={20} strokeWidth={2.5} />
              </button>
            )}
            {user?.role !== 'sales_rep' && (
              <button
                title="KYC Review Queue"
                onClick={() => setActivePage('kyc-review')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  activePage === 'kyc-review'
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
                }`}
              >
                <ShieldCheck size={20} strokeWidth={2.5} />
              </button>
            )}
            {/* Show tour — only for roles that have a walkthrough */}
            {walkthroughSteps && (
              <button
                title="Show tour"
                onClick={handleShowTour}
                className="p-3 rounded-xl flex items-center justify-center transition-all text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600"
              >
                <HelpCircle size={20} strokeWidth={2.5} />
              </button>
            )}
            <button
              title="Settings"
              onClick={() => setActivePage('settings')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                activePage === 'settings'
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
              }`}
            >
              <Settings size={20} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4">
          <button
            onClick={logout}
            className="w-10 h-10 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center text-zinc-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors focus:ring-2 focus:ring-offset-2 focus:ring-red-500 outline-none"
          >
            <User size={18} />
          </button>
        </div>
      </nav>

      {/* Main Application Area */}
      <main className="flex-1 flex overflow-hidden relative min-w-0">
        <div className="flex-1 flex flex-col bg-white min-w-0">
          <div className="flex-1 overflow-hidden overflow-y-auto">{renderMain()}</div>
        </div>
      </main>

      {/* Bottom Navigation — visible on mobile only */}
      <nav
        className="flex md:hidden shrink-0 border-t border-zinc-200 bg-white items-center justify-around px-2 py-1 z-10"
        aria-label="Mobile navigation"
      >
        {isPipelineRole && (
          <button
            title="Pipeline"
            data-testid="nav-pipeline-mobile"
            onClick={() => setActivePage('pipeline')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'pipeline' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <KanbanSquare size={20} strokeWidth={2.5} />
          </button>
        )}
        {isPipelineRole && (
          <button
            title="Lead queue"
            data-testid="nav-leads-mobile"
            onClick={() => {
              setActivePage('leads');
              setSelectedLeadId(null);
            }}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'leads' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <Users size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.role === 'collections_agent' || user?.isSuperadmin) && (
          <button
            title="Case Queue"
            data-testid="nav-collection-queue-mobile"
            onClick={() => {
              setActivePage('collection-queue');
              setSelectedCaseId(null);
            }}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'collection-queue' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <Briefcase size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.role === 'account_manager' || user?.isSuperadmin) && (
          <button
            title="Customer Health"
            data-testid="nav-account-manager-dashboard-mobile"
            onClick={() => setActivePage('account-manager-dashboard')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'account-manager-dashboard' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <Activity size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.isBdm || user?.isSuperadmin) && (
          <button
            title="Campaign Analysis"
            data-testid="nav-campaign-analysis-mobile"
            onClick={() => setActivePage('campaign-analysis')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'campaign-analysis' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <BarChart2 size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.isCfo || user?.isSuperadmin) && (
          <button
            title="CFO Portfolio"
            onClick={() => setActivePage('cfo-portfolio')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'cfo-portfolio' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <TrendingUp size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.isCfo || user?.isSuperadmin) && (
          <button
            title="Reports"
            data-testid="nav-cfo-reports-mobile"
            onClick={() => setActivePage('cfo-reports')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'cfo-reports' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <FileBarChart size={20} strokeWidth={2.5} />
          </button>
        )}
        {(user?.role === 'finance_controller' || user?.isSuperadmin) && (
          <button
            title="CFO Dashboard"
            data-testid="nav-cfo-dashboard-mobile"
            onClick={() => setActivePage('cfo-dashboard')}
            className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
              activePage === 'cfo-dashboard' ? 'text-indigo-600' : 'text-zinc-400'
            }`}
          >
            <TrendingUp size={20} strokeWidth={2.5} />
          </button>
        )}
        <button
          title="Settings"
          onClick={() => setActivePage('settings')}
          className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
            activePage === 'settings' ? 'text-indigo-600' : 'text-zinc-400'
          }`}
        >
          <Settings size={20} strokeWidth={2.5} />
        </button>
        <button
          title="Logout"
          onClick={logout}
          className="flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all text-zinc-400 hover:text-red-500"
        >
          <User size={20} strokeWidth={2.5} />
        </button>
      </nav>
    </div>
  );
}

export default function Root() {
  return (
    <AuthProvider>
      <MobileGate>
        <App />
      </MobileGate>
    </AuthProvider>
  );
}
