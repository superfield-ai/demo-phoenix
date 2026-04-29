import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import {
  Settings,
  User,
  Users,
  KanbanSquare,
  TrendingUp,
  HelpCircle,
  BookOpen,
} from 'lucide-react';
import { MobileInstallPage } from './pages/mobile-install';
import { SettingsPage } from './pages/settings';
import { LeadDetailPage } from './pages/lead-detail';
import { LeadQueuePage } from './pages/lead-queue';
import { PipelineBoardPage } from './pages/pipeline-board';
import { CfoPortfolioPage } from './pages/cfo-portfolio';
import { WikiViewPage } from './pages/wiki-view';
import { usePlatform } from './hooks/use-platform';
import { isDismissalActive, DISMISSED_KEY } from './components/pwa/install-prompt';
import { NotificationBell } from './components/NotificationBell';
import {
  WalkthroughModal,
  SALES_REP_STEPS,
  CFO_STEPS,
  resetOnboarding,
} from './components/WalkthroughModal';

type ActivePage = 'pipeline' | 'leads' | 'settings' | 'cfo-portfolio' | 'wiki';

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
function getWalkthroughSteps(role: string | null | undefined, isCfo: boolean | undefined) {
  if (isCfo || role === 'cfo') return CFO_STEPS;
  if (role === 'sales_rep') return SALES_REP_STEPS;
  return null;
}

function App() {
  const { user, logout, loading } = useAuth();
  const [activePage, setActivePage] = useState<ActivePage>('pipeline');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showWalkthrough, setShowWalkthrough] = useState<boolean | null>(null);

  // Determine whether to show the walkthrough once we have user data
  React.useEffect(() => {
    if (!user) return;
    // Show if onboarding is not yet completed
    if (user.onboarding_completed === false) {
      const steps = getWalkthroughSteps(user.role, user.isCfo);
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

  const walkthroughSteps = getWalkthroughSteps(user.role, user.isCfo);

  function renderMain() {
    if (activePage === 'pipeline') {
      return <PipelineBoardPage />;
    }
    if (activePage === 'leads') {
      if (selectedLeadId) {
        return (
          <LeadDetailPage prospectId={selectedLeadId} onBack={() => setSelectedLeadId(null)} />
        );
      }
      return <LeadQueuePage onSelectLead={(id) => setSelectedLeadId(id)} />;
    }
    if (activePage === 'cfo-portfolio') {
      return <CfoPortfolioPage />;
    }
    if (activePage === 'wiki') {
      return <WikiViewPage customerId="demo" />;
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
            <button
              title="Pipeline"
              onClick={() => setActivePage('pipeline')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                activePage === 'pipeline'
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
              }`}
            >
              <KanbanSquare size={20} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => {
                setActivePage('leads');
                setSelectedLeadId(null);
              }}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activePage === 'leads' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700'}`}
              title="Lead queue"
            >
              <Users size={20} strokeWidth={2.5} />
            </button>
            <NotificationBell
              onSelectLead={(prospectId) => {
                setActivePage('leads');
                setSelectedLeadId(prospectId);
              }}
            />
            <button
              data-testid="nav-wiki"
              title="Wiki"
              onClick={() => setActivePage('wiki')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                activePage === 'wiki'
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'
              }`}
            >
              <BookOpen size={20} strokeWidth={2.5} />
            </button>
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
        <button
          title="Pipeline"
          onClick={() => setActivePage('pipeline')}
          className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
            activePage === 'pipeline' ? 'text-indigo-600' : 'text-zinc-400'
          }`}
        >
          <KanbanSquare size={20} strokeWidth={2.5} />
        </button>
        <button
          title="Lead queue"
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
        <button
          data-testid="nav-wiki"
          title="Wiki"
          onClick={() => setActivePage('wiki')}
          className={`flex flex-col items-center justify-center gap-0.5 p-2 rounded-xl min-w-[44px] min-h-[44px] transition-all ${
            activePage === 'wiki' ? 'text-indigo-600' : 'text-zinc-400'
          }`}
        >
          <BookOpen size={20} strokeWidth={2.5} />
        </button>
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
