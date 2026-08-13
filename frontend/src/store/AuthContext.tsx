import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { auth } from '../api/endpoints';
import { request, setAccessToken, setAuthLostHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  /** True until the initial silent refresh settles, so guards do not flash. */
  initialising: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initialising, setInitialising] = useState(true);

  // The API client calls this when a refresh fails, so a revoked session clears
  // the UI instead of leaving a stale user in place.
  useEffect(() => {
    setAuthLostHandler(() => setUser(null));
    return () => setAuthLostHandler(null);
  }, []);

  // On boot the access token is gone — it only ever lived in memory — but the
  // refresh cookie may still be valid, so try once to restore the session.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { accessToken } = await request<{ accessToken: string; user: User }>(
          '/auth/refresh',
          { method: 'POST', skipRefresh: true },
        );
        setAccessToken(accessToken);
        const { user: me } = await auth.me();
        if (!cancelled) setUser(me);
      } catch {
        // No valid session; carry on as a guest.
        if (!cancelled) setAccessToken(null);
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { user: me, accessToken } = await auth.login({ email, password });
    setAccessToken(accessToken);
    setUser(me);
    return me;
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; firstName?: string; lastName?: string }) => {
      const { user: me, accessToken } = await auth.register(input);
      setAccessToken(accessToken);
      setUser(me);
      return me;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // Clear local state even if the network call failed — the user asked to
      // sign out, and the cookie is cleared server-side on the next attempt.
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initialising, isAdmin: user?.role === 'ADMIN', login, register, logout }),
    [user, initialising, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
