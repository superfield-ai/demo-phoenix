import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { Settings, User, Users, KanbanSquare } from 'lucide-react';
import { MobileInstallPage } from './pages/mobile-install';
import { SettingsPage } from './pages/settings';
import { LeadDetailPage, LeadQueuePage } from './pages/lead-detail';
import { PipelineBoardPage } from './pages/pipeline-board';
import { usePlatform } from './hooks/use-platform';
import { isDismissalActive, DISMISSED_KEY } from './components/pwa/install-prompt';
import { NotificationBell } from './components/NotificationBell';

type ActivePage = 'pipeline' | 'leads' | 'settings';

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

function App() {
  const { user, logout, loading } = useAuth();
  const [activePage, setActivePage] = useState<ActivePage>('pipeline');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

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
    return <SettingsPage />;
  }

  return (
    <div className="flex h-screen w-full bg-zinc-50 font-sans overflow-hidden text-zinc-900">
      {/* Left Sidebar */}
      <nav className="w-16 shrink-0 border-r border-zinc-200 bg-white flex flex-col items-center py-6 justify-between z-10">
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
      <main className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col bg-white">
          <div className="flex-1 overflow-hidden overflow-y-auto">{renderMain()}</div>
        </div>
      </main>
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
