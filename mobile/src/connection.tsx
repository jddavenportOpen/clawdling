// The one place that knows whether the app is connected (to a real server or to the demo), and
// the one place that handles "your computer stopped accepting this phone" (HTTP 401): it drops
// the stored pairing and sends the user back to Connect with a plain explanation.

import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HttpClient, type ApiError } from './api';
import { DemoClient } from './demo/demo';
import { clearConnection, loadConnection, saveConnection, type StoredConnection } from './storage';
import type { ClawdlingClient } from './types';

export const AUTH_LOST_NOTICE =
  "Your computer no longer accepts this phone's pairing code. In the cockpit, open Settings, then Connect your phone, and scan the new code.";

interface ConnectionContextValue {
  /** False until the stored pairing has been read at launch. */
  ready: boolean;
  connection: StoredConnection | null;
  client: ClawdlingClient | null;
  /** A message for the Connect screen (why we were sent back there). */
  notice: string | null;
  connect(url: string, token: string): Promise<void>;
  startDemo(): Promise<void>;
  disconnect(notice?: string | null): Promise<void>;
  clearNotice(): void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function resetTo(path: '/connect' | '/home') {
  try {
    if (router.canDismiss()) router.dismissAll();
  } catch {
    // nothing to dismiss
  }
  router.replace(path);
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const demoRef = useRef<DemoClient | null>(null);
  const authLostRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadConnection().then((c) => {
      if (!alive) return;
      setConnection(c);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const disconnect = useCallback(async (why: string | null = null) => {
    await clearConnection();
    demoRef.current = null;
    setConnection(null);
    setNotice(why);
    resetTo('/connect');
  }, []);

  const onAuthError = useCallback(
    (_err: ApiError) => {
      if (authLostRef.current) return;
      authLostRef.current = true;
      void disconnect(AUTH_LOST_NOTICE);
    },
    [disconnect],
  );

  const client = useMemo<ClawdlingClient | null>(() => {
    if (!connection) return null;
    if (connection.mode === 'demo') {
      if (!demoRef.current) demoRef.current = new DemoClient();
      return demoRef.current;
    }
    return new HttpClient({ baseUrl: connection.url, token: connection.token, onAuthError });
  }, [connection, onAuthError]);

  const connect = useCallback(async (url: string, token: string) => {
    const c: StoredConnection = { mode: 'live', url, token };
    await saveConnection(c);
    authLostRef.current = false;
    demoRef.current = null;
    setNotice(null);
    setConnection(c);
    resetTo('/home');
  }, []);

  const startDemo = useCallback(async () => {
    await saveConnection({ mode: 'demo' });
    authLostRef.current = false;
    demoRef.current = new DemoClient();
    setNotice(null);
    setConnection({ mode: 'demo' });
    resetTo('/home');
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  const value = useMemo(
    () => ({ ready, connection, client, notice, connect, startDemo, disconnect, clearNotice }),
    [ready, connection, client, notice, connect, startDemo, disconnect, clearNotice],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const v = useContext(ConnectionContext);
  if (!v) throw new Error('useConnection must be used inside ConnectionProvider');
  return v;
}

/** The client for a screen that requires a connection (screens redirect to Connect without one). */
export function useClient(): ClawdlingClient | null {
  return useConnection().client;
}
