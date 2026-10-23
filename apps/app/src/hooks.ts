import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { scopeView, type ScopeView } from '@mun/core';
import type { AppSession } from './session';

export const SessionContext = createContext<AppSession | null>(null);

/** The running session; the component re-renders whenever anything in it changes. */
export function useSession(): AppSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside a session');
  const [, setVersion] = useState(session.version);
  useEffect(() => session.subscribe(() => setVersion(session.version)), [session]);
  return session;
}

/** A scope as it should look, recomputed only when the session changes. */
export function useScope(scope: string | undefined): ScopeView | null {
  const session = useSession();
  const version = session.version;
  return useMemo(
    () => (scope && session.node.replica.keeps(scope) ? scopeView(session.node.replica, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, scope, version],
  );
}

/** Re-renders every `ms`, for relative times and slow-mode countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
