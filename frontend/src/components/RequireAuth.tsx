import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../store/AuthContext';
import { LoadingBlock } from './ui';

/**
 * Gate for authenticated routes. While the initial silent refresh is in flight
 * we must not redirect, or a signed-in user landing directly on /orders would
 * be bounced to the login page before their session is restored.
 */
export function RequireAuth({ children, adminOnly }: { children: ReactNode; adminOnly?: boolean }) {
  const { user, initialising, isAdmin } = useAuth();
  const location = useLocation();

  if (initialising) return <LoadingBlock label="Checking your session" />;

  if (!user) {
    // Remember where they were headed so login can send them back.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
