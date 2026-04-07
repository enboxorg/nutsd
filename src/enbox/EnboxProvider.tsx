import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AuthManager, BrowserConnectHandler, Enbox } from '@enbox/browser';
import type { AuthSession } from '@enbox/browser';
import { CashuWalletDefinition } from '@/protocol/cashu-wallet-protocol';
import { CashuTransferDefinition } from '@/protocol/cashu-transfer-protocol';
import { brand } from '@/lib/brand';

// Protocol is auto-configured via repository().configure() in use-wallet.ts

/** All protocol definitions this dapp needs permissions for. */
const DAPP_PROTOCOLS = [CashuWalletDefinition, CashuTransferDefinition];

/** DWN endpoints that new identities register with and sync to. */
const DWN_ENDPOINTS = [
  'https://dev.aws.dwn.enbox.id',
  'https://enbox-dwn.fly.dev',
];

/**
 * Get or create a random vault password and persist it in localStorage.
 *
 * For a dapp (not a wallet), the vault password protects the local DID's
 * private keys at rest. A crypto-random password per browser is sufficient —
 * if the user clears storage, they recover via their 12-word seed phrase.
 */
function getOrCreateVaultPassword(): string {
  const STORAGE_KEY = 'enbox:vault-password';
  let password = localStorage.getItem(STORAGE_KEY);
  if (!password) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    password = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(STORAGE_KEY, password);
  }
  return password;
}

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
  /** Whether the session is delegate-based (wallet-connected) vs local-only. */
  isDelegateSession: boolean;
  /** The underlying AuthManager (for advanced flows like QR connect). */
  auth: AuthManager | null;
  /**
   * Create a new local DID (owner identity with X25519 encryption keys).
   */
  connectLocal: () => Promise<void>;
  /** Connect to an external Enbox wallet via delegated wallet-connect. */
  connectWallet: () => Promise<void>;
  /** Apply a session obtained from an external flow (e.g. QR connect). */
  applySession: (session: AuthSession) => void;
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
  isDelegateSession   : false,
  auth                : null,
  connectLocal        : () => Promise.reject(new Error('EnboxProvider not mounted')),
  connectWallet       : () => Promise.reject(new Error('EnboxProvider not mounted')),
  applySession        : () => {},
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
  const [isDelegateSession, setIsDelegateSession] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | undefined>();

  const walletOptions = useMemo(
    () => brand.preferredWalletUrl === 'https://blue-enbox-wallet.pages.dev/'
      ? [
          { name: 'Blue Enbox Wallet', url: 'https://blue-enbox-wallet.pages.dev', description: 'Your digital identity wallet' },
          { name: 'Enbox Wallet', url: 'https://enbox-wallet.pages.dev', description: 'Your digital identity wallet' },
        ]
      : [
          { name: 'Enbox Wallet', url: 'https://enbox-wallet.pages.dev', description: 'Your digital identity wallet' },
          { name: 'Blue Enbox Wallet', url: 'https://blue-enbox-wallet.pages.dev', description: 'Your digital identity wallet' },
        ],
    [],
  );

  const applySession = useCallback((session: AuthSession) => {
    const api = Enbox.connect({ session });
    setEnbox(api);
    setDid(session.did);
    setIsDelegateSession(!!session.delegateDid);
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
        authRef.current = await AuthManager.create({
          password       : getOrCreateVaultPassword(),
          dwnEndpoints   : DWN_ENDPOINTS,
          registration   : {
            onSuccess      : () => console.log('[nutsd] DWN registration complete'),
            onFailure      : (err) => console.warn('[nutsd] DWN registration failed:', err),
            persistTokens  : true,
          },
          connectHandler : BrowserConnectHandler({
            wallets : walletOptions,
            appName : brand.name,
            appIcon : `${window.location.origin}/favicon.ico`,
          }),
        });
        if (cancelled) { return; }

        const session = await authRef.current.restoreSession();
        if (cancelled) { return; }

        if (session) {
          applySession(session);
        }
      } catch (err) {
        console.error('[nutsd] Auth init failed:', err);
      } finally {
        if (!cancelled) { setIsConnecting(false); }
      }
    }

    init();
    return () => { cancelled = true; };
  }, [applySession, walletOptions]);

  // ── Connect local: create a new DID with full key material ──────
  // Creates a did:dht with Ed25519 (signing) + X25519 (encryption).
  const connectLocal = useCallback(async () => {
    const auth = authRef.current;
    if (!auth) { throw new Error('AuthManager not ready'); }

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

  const connectWallet = useCallback(async () => {
    const auth = authRef.current;
    if (!auth) { throw new Error('AuthManager not ready'); }

    setIsConnecting(true);
    try {
      const session = await auth.connect({
        protocols: DAPP_PROTOCOLS,
      });
      applySession(session);
    } finally {
      setIsConnecting(false);
    }
  }, [applySession]);

  // ── Disconnect ───────────────────────────────────────────────────
  const disconnect = useCallback(async (options?: { clearStorage?: boolean }) => {
    const auth = authRef.current;
    if (!auth) { return; }

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
        isDelegateSession,
        auth                : authRef.current,
        connectLocal,
        connectWallet,
        applySession,
        disconnect,
        recoveryPhrase,
        clearRecoveryPhrase,
      }}
    >
      {children}
    </EnboxContext.Provider>
  );
};
