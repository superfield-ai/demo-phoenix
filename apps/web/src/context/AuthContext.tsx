import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { makeFetchWithAuth } from '../lib/fetch-with-auth';

export interface User {
  id: string;
  username: string;
  isSuperadmin?: boolean;
  isCrmAdmin?: boolean;
  isComplianceOfficer?: boolean;
  role?: string | null;
  isCfo?: boolean;
  isBdm?: boolean;
  onboarding_completed?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
  /** A fetch wrapper that auto-includes credentials and calls logout on 401. */
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Absolute session timeout in milliseconds.
 *
 * Reads VITE_SESSION_TIMEOUT_HOURS at build time (injected by Vite from the
 * environment variable SESSION_TIMEOUT_HOURS). Falls back to 8 hours when the
 * variable is absent or unparseable.
 */
function resolveSessionTimeoutMs(): number {
  const raw = import.meta.env.VITE_SESSION_TIMEOUT_HOURS;
  const hours = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
}

const SESSION_TIMEOUT_MS = resolveSessionTimeoutMs();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * The absolute timestamp (ms since epoch) at which the client-side session
   * expires.  Computed once when /api/auth/me succeeds, as:
   *   sessionStartTime + SESSION_TIMEOUT_MS
   *
   * This enforces an absolute client-side timeout independent of the JWT exp
   * claim, capped at SESSION_TIMEOUT_HOURS (default 8) from the time the
   * session was last verified server-side.
   *
   * Stored as a ref so it does not trigger re-renders on its own.
   */
  const sessionExpiresAtRef = useRef<number | null>(null);

  // logoutRef allows fetchWithAuth to call the most up-to-date logout function
  // without recreating the fetch wrapper on every render.
  const logoutRef = useRef<() => Promise<void>>(async () => {});

  // fetchWithAuth is created once and delegates to logoutRef.current so it
  // always calls the current logout without recreating the closure.
  // The empty dep array is intentional — logoutRef is a stable ref object and
  // logoutRef.current is kept up to date by the sync effect that follows.
  const fetchWithAuth = React.useMemo(
    () => makeFetchWithAuth(() => logoutRef.current()),
    [], // stable ref — intentionally empty dep array
  );

  const logout = React.useCallback(async () => {
    sessionExpiresAtRef.current = null;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (err) {
      console.error(err);
    } finally {
      setUser(null);
    }
  }, []);

  // Keep logoutRef in sync so fetchWithAuth always calls the latest logout.
  useEffect(() => {
    logoutRef.current = logout;
  }, [logout]);

  useEffect(() => {
    // On mount, verify the session with the server.
    fetch('/api/auth/me', { method: 'GET', credentials: 'include' })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.user) {
            setUser(data.user as User);
            // Start the absolute client-side session timeout clock.
            sessionExpiresAtRef.current = Date.now() + SESSION_TIMEOUT_MS;
          }
        } else if (res.status === 401) {
          // 401 on initial check — no user, stays null.  This is the expected
          // path for unauthenticated visitors; no warning needed.
          setUser(null);
        } else {
          console.warn(`Auth check failed with status: ${res.status}`);
        }
      })
      .catch((err) => {
        // Network error — stay unauthenticated.
        console.error('Auth check failed:', err);
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * Enforce the absolute session timeout on every render.
   *
   * If the session has expired client-side, call logout() in an effect to
   * clear user state before any child component can act on stale auth data.
   */
  const sessionExpired =
    user !== null &&
    sessionExpiresAtRef.current !== null &&
    Date.now() >= sessionExpiresAtRef.current;

  useEffect(() => {
    if (sessionExpired) {
      void logout();
    }
  }, [sessionExpired, logout]);

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout, fetchWithAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
