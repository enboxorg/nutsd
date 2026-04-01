import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';

import { AuthManager } from '@enbox/auth';
import type { AuthSession } from '@enbox/auth';
import { Enbox } from '@enbox/api';
import { BrowserConnectHandler } from '@enbox/browser';

import { CashuWalletDefinition } from '@/protocol/cashu-wallet-protocol';
import { CashuTransferDefinition } from '@/protocol/cashu-transfer-protocol';

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface EnboxContextProps {
  /** The high-level Enbox API. Undefined until connected. */
  enbox?: Enbox;
  /** The connected DID URI. */
  did?: string;
  /** Whether a connection is currently in progress. */
  isConnecting: boolean;
  /** Whether a session is active. */
  isConnected: boolean;
  /** Connect to a wallet via the browser popup flow. */
  connect: () => Promise<void>;
  /** Create a new local DID (no wallet needed). */
  connectLocal: () => Promise<void>;
  /** Disconnect (clean by default, nuclear if clearStorage is true). */
  disconnect: (options?: { clearStorage?: boolean }) => Promise<void>;
  /** The recovery phrase shown on first-time local connect. */
  recoveryPhrase?: string;
  /** Clear the recovery phrase after the user has backed it up. */
  clearRecoveryPhrase: () => void;
}

export const EnboxContext = createContext<EnboxContextProps>({
  isConnecting        : false,
  isConnected         : false,
  connect             : () => Promise.reject(new Error('EnboxProvider not mounted')),
  connectLocal        : () => Promise.reject(new Error('EnboxProvider not mounted')),
  disconnect          : () => Promise.reject(new Error('EnboxProvider not mounted')),
  clearRecoveryPhrase : () => {},
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const EnboxProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const authRef = useRef<AuthManager | null>(null);
  const [enbox, setEnbox] = useState<Enbox | undefined>();
  const [did, setDid] = useState<string | undefined>();
  const [isConnecting, setIsConnecting] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | undefined>();

  const applySession = useCallback((session: AuthSession) => {
    const api = Enbox.connect({ session });
    setEnbox(api);
    setDid(session.did);
    if (session.recoveryPhrase) {
      setRecoveryPhrase(session.recoveryPhrase);
    }
  }, []);

  // ── Bootstrap: create AuthManager once, then auto-restore ────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsConnecting(true);
      try {
        const auth = await AuthManager.create({
          connectHandler : BrowserConnectHandler({
            wallets: [
              { name: 'Enbox Wallet', url: 'https://enbox-wallet.pages.dev' },
              { name: 'Enbox Wallet (Blue)', url: 'https://blue-enbox-wallet.pages.dev' },
            ],
          }),
        });
        if (cancelled) return;
        authRef.current = auth;

        const session = await auth.restoreSession();
        if (cancelled) return;

        if (session) {
          applySession(session);
        }
      } catch (err) {
        console.error('[nutsd] Auth init failed:', err);
      } finally {
        if (!cancelled) setIsConnecting(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [applySession]);

  // ── Connect: wallet popup flow ──────────────────────────────────
  const connect = useCallback(async () => {
    const auth = authRef.current;
    if (!auth) throw new Error('AuthManager not ready');

    setIsConnecting(true);
    try {
      const session = await auth.connect({
        protocols: [CashuWalletDefinition, CashuTransferDefinition],
      });
      applySession(session);
    } finally {
      setIsConnecting(false);
    }
  }, [applySession]);

  // ── Connect local: create a new DID without a wallet ────────────
  const connectLocal = useCallback(async () => {
    const auth = authRef.current;
    if (!auth) throw new Error('AuthManager not ready');

    setIsConnecting(true);
    try {
      const session = await auth.connectLocal({
        createIdentity: true,
      });
      applySession(session);
    } finally {
      setIsConnecting(false);
    }
  }, [applySession]);

  // ── Disconnect ───────────────────────────────────────────────────
  const disconnect = useCallback(async (options?: { clearStorage?: boolean }) => {
    const auth = authRef.current;
    if (!auth) return;

    await auth.disconnect({ clearStorage: options?.clearStorage });
    setEnbox(undefined);
    setDid(undefined);
    setRecoveryPhrase(undefined);

    if (options?.clearStorage) {
      window.location.reload();
    }
  }, []);

  const clearRecoveryPhrase = useCallback(() => {
    setRecoveryPhrase(undefined);
  }, []);

  const isConnected = enbox !== undefined;

  return (
    <EnboxContext.Provider
      value={{
        enbox,
        did,
        isConnecting,
        isConnected,
        connect,
        connectLocal,
        disconnect,
        recoveryPhrase,
        clearRecoveryPhrase,
      }}
    >
      {children}
    </EnboxContext.Provider>
  );
};
