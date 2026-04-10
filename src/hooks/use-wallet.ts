/**
 * Top-level wallet hook.
 *
 * Initializes the DWN repository for the Cashu Wallet protocol,
 * sets up subscriptions for real-time sync, and provides the
 * repository to child hooks.
 *
 * PROOF STATE TRACKING:
 * Each proof has a `state` field (unspent | pending) persisted in DWN.
 * Before any mint operation, proofs are marked `pending` in the DWN first.
 * On startup, `reconcilePendingProofs()` checks all pending proofs with the
 * mint via NUT-07 and reverts or deletes them accordingly.
 *
 * KEYSET MANAGEMENT:
 * Keyset records are written as children of mint records, storing the
 * NUT-02 input fee rate, active status, and unit for each keyset.
 * Fee rates are used for fee-aware UI display and proof selection.
 *
 * TAG POLICY: Encrypted record types (proof, keyset, transaction)
 * carry NO DWN tags. All filtering is done client-side after decryption.
 *
 * @module
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { repository } from '@enbox/browser';
import { useEnbox } from '@/enbox';
import {
  CashuWalletProtocol,
  type MintData,
  type ProofData,
  type KeysetData,
  type TransactionData,
  type PreferenceData,
  type P2pkKeyData,
  type ProofStashData,
  type ProofState,
} from '@/protocol/cashu-wallet-protocol';
import { CashuTransferProtocol } from '@/protocol/cashu-transfer-protocol';
import type { TransferData } from '@/protocol/cashu-transfer-protocol';
import type { Proof } from '@cashu/cashu-ts';
import {
  groupProofsByState,
  getKeysetInfos,
  getMintInfo,
  clearWalletCache,
  evictWalletCache,
  type KeysetInfo,
} from '@/cashu/wallet-ops';
import { generateP2pkKeyPair, receiveP2pkLocked, type P2pkKeyPair } from '@/cashu/p2pk';
import { recoverStashes, type RecoveryDeps } from '@/cashu/proof-stash-recovery';
import { resumePendingSwap, type PendingSwapState } from '@/cashu/cross-mint-swap';
import { resumePendingMint, parsePendingMintState } from '@/cashu/pending-mint-recovery';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { formatAmount, toastSuccess } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Domain types — flattened from TypedRecord for the UI layer
// ---------------------------------------------------------------------------

export interface Mint {
  id: string;
  contextId: string;
  url: string;
  name?: string;
  unit: string;
  active: boolean;
  info?: Record<string, unknown>;
}

export interface StoredProof {
  id: string;
  contextId: string;
  /** The contextId of the mint this proof belongs to. */
  mintContextId: string;
  /** The mint URL this proof belongs to. */
  mintUrl: string;
  amount: number;
  keysetId: string;
  secret: string;
  C: string;
  state: ProofState;
  dleq?: { e: string; s: string; r: string };
  witness?: string;
}

export interface Keyset {
  id: string;
  contextId: string;
  /** Parent mint context ID. */
  mintContextId: string;
  /** Keyset ID from the mint. */
  keysetId: string;
  unit: string;
  active: boolean;
  /** NUT-02 input fee rate in parts per thousand. */
  inputFeePpk: number;
}

export interface Transaction {
  id: string;
  type: TransactionData['type'];
  amount: number;
  unit: string;
  mintUrl: string;
  status: TransactionData['status'];
  /** Claim status for 'send' and 'p2p-send'. Undefined for other types. */
  claimStatus?: TransactionData['claimStatus'];
  /** ISO timestamp when the token was confirmed claimed. */
  claimedAt?: string;
  /** Encrypted cashu token for sends. Cleared once confirmed spent. */
  cashuToken?: string;
  recipientDid?: string;
  senderDid?: string;
  memo?: string;
  createdAt: string;
  /** BOLT-11 invoice for pending mint transactions. Cleared on completion. */
  invoice?: string;
  /** Mint quote ID for status checks. Cleared on completion. */
  quoteId?: string;
  /** ISO timestamp when the invoice expires. */
  expiresAt?: string;
}

export interface WalletPreferences {
  defaultMintUrl?: string;
  defaultUnit?: string;
  displayCurrency?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type Repo = any;

export function useWallet() {
  const { enbox, isConnected, did: connectedDid, isDelegateSession } = useEnbox();

  const [repo, setRepo] = useState<Repo>(null);
  const typedRef = useRef<any>(null);
  const transferTypedRef = useRef<any>(null);

  // --- Core state ---
  const [mints, setMints] = useState<Mint[]>([]);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [keysets, setKeysets] = useState<Keyset[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [preferences, setPreferences] = useState<WalletPreferences>({});
  const [p2pkKey, setP2pkKey] = useState<P2pkKeyPair | null>(null);
  const [incomingTransfers, setIncomingTransfers] = useState<TransferData[]>([]);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [dwnError, setDwnError] = useState<string | null>(null);
  const [mintHealth, setMintHealth] = useState<Map<string, boolean>>(new Map());

  // --- DWN record cache (for in-place updates) ---
  const proofRecordCache = useRef<Map<string, any>>(new Map());
  // --- Transfer record cache (for deletion after redemption) ---
  const incomingTransferRecordsRef = useRef<Array<{ data: TransferData; record: any }>>([]);

  /**
   * Install both protocols on the local DWN (and best-effort send to remote),
   * then return the wallet repository. Awaiting configure() is critical —
   * data loading hooks (loadP2pkKey, refreshMints, etc.) depend on repo and
   * will query empty results if the protocol isn't installed yet.
   *
   * For DELEGATE sessions: skip configure() for the wallet protocol.
   * The wallet already configured it during the connect approval flow with
   * proper $encryption key derivation from the owner's X25519 key. If the
   * delegate eagerly re-configures, the new ProtocolsConfigure (signed by
   * the delegate, not the owner) could overwrite the owner's configure and
   * break encrypted record access (p2pkKey, proofs, etc.).
   *
   * The transfer protocol does NOT have encryptionRequired, so it's safe
   * to configure in both modes.
   */
  const initializeProtocols = useCallback(async (enboxInstance: any, isDelegate: boolean): Promise<Repo> => {
    const typed = enboxInstance.using(CashuWalletProtocol);
    typedRef.current = typed;
    const r = repository(typed);

    if (!isDelegate) {
      // Owner session: configure the wallet protocol (includes $encryption keys).
      try {
        const res = await r.configure() as any;
        res?.protocol?.send?.(connectedDid)?.catch?.(() => {});
      } catch (err) {
        console.warn('[nutsd] Protocol configure:', err);
      }
    } else {
      console.log('[nutsd] Delegate session — skipping wallet protocol configure (already configured by wallet owner)');
    }

    // Transfer protocol: safe to configure in both modes (no encryptionRequired).
    const transferTyped = enboxInstance.using(CashuTransferProtocol);
    transferTypedRef.current = transferTyped;
    const transferRepo = repository(transferTyped);

    try {
      const res = await transferRepo.configure() as any;
      res?.protocol?.send?.(connectedDid)?.catch?.(() => {});
    } catch (err) {
      console.warn('[nutsd] Transfer protocol configure:', err);
    }

    return r;
  }, [connectedDid]);

  /** Reset all state on disconnect. */
  const resetState = useCallback(() => {
    typedRef.current = null;
    transferTypedRef.current = null;
    setRepo(null);
    setMints([]);
    setProofs([]);
    setKeysets([]);
    setTransactions([]);
    setPreferences({});
    setP2pkKey(null);
    setIncomingTransfers([]);
    setDwnError(null);
    proofRecordCache.current.clear();
    incomingTransferRecordsRef.current = [];
    clearWalletCache();
    startupRecoveryDone.current = false;
  }, []);

  // Initialize protocols and repo when connected.
  useEffect(() => {
    if (!enbox || !isConnected) {
      resetState();
      return;
    }

    let cancelled = false;
    initializeProtocols(enbox, isDelegateSession).then((r) => {
      if (!cancelled) { setRepo(r); }
    });
    return () => { cancelled = true; };
  }, [enbox, isConnected, isDelegateSession, initializeProtocols, resetState]);

  // =========================================================================
  // Refresh functions
  // =========================================================================

  const refreshMints = useCallback(async () => {
    if (!repo) return;
    setDwnError(null);
    try {
      const { records } = await repo.mint.query();
      setMints(
        await Promise.all(records.map(async (r: Record<string, unknown>) => {
          const data = await (r as { data: { json: () => Promise<MintData> } }).data.json();
          return {
            id        : (r as { id: string }).id,
            contextId : ((r as { contextId?: string }).contextId) ?? (r as { id: string }).id,
            url       : data.url,
            name      : data.name,
            unit      : data.unit,
            active    : data.active,
            info      : data.info,
          } satisfies Mint;
        })),
      );
    } catch (err) {
      console.error('Failed to load mints:', err);
      setDwnError('Failed to load wallet data. Check your connection.');
    }
  }, [repo]);

  /**
   * Load all proofs from the DWN and update React state.
   * Returns the loaded proofs directly (not via React state, which is async).
   */
  const refreshProofs = useCallback(async (): Promise<StoredProof[]> => {
    if (!repo || mints.length === 0) {
      setProofs([]);
      proofRecordCache.current.clear();
      return [];
    }
    setDwnError(null);
    try {
      const allProofs: StoredProof[] = [];
      const newCache = new Map<string, any>();

      for (const mint of mints) {
        // Query by parent context (mint), no tags — all filtering client-side
        const { records } = await repo.mint.proof.query(mint.contextId);
        for (const r of records) {
          const data: ProofData = await r.data.json();
          // Cache the DWN record for in-place state updates
          newCache.set(r.id, r);
          allProofs.push({
            id             : r.id,
            contextId      : r.contextId ?? r.id,
            mintContextId  : mint.contextId,
            mintUrl        : mint.url,
            amount         : data.amount,
            keysetId       : data.id,
            secret         : data.secret,
            C              : data.C,
            // Read persisted state; default 'unspent' for backward compat
            state          : data.state ?? 'unspent',
            dleq           : data.dleq,
            witness        : data.witness,
          });
        }
      }
      proofRecordCache.current = newCache;
      setProofs(allProofs);
      return allProofs;
    } catch (err) {
      console.error('Failed to load proofs:', err);
      setDwnError('Failed to load wallet data. Check your connection.');
      return [];
    }
  }, [repo, mints]);

  const refreshKeysets = useCallback(async () => {
    if (!repo || mints.length === 0) {
      setKeysets([]);
      return;
    }
    setDwnError(null);
    try {
      const allKeysets: Keyset[] = [];
      for (const mint of mints) {
        const { records } = await repo.mint.keyset.query(mint.contextId);
        for (const r of records) {
          const data: KeysetData = await r.data.json();
          allKeysets.push({
            id             : r.id,
            contextId      : r.contextId ?? r.id,
            mintContextId  : mint.contextId,
            keysetId       : data.keysetId,
            unit           : data.unit,
            active         : data.active,
            inputFeePpk    : data.inputFeePpk ?? 0,
          });
        }
      }
      setKeysets(allKeysets);
    } catch (err) {
      console.error('Failed to load keysets:', err);
      setDwnError('Failed to load wallet data. Check your connection.');
    }
  }, [repo, mints]);

  const refreshTransactions = useCallback(async () => {
    if (!repo) return;
    setDwnError(null);
    try {
      // Query all transactions — no tags, filter/sort client-side
      const { records } = await repo.transaction.query();
      const txList = await Promise.all(records.map(async (r: Record<string, unknown>) => {
        const data = await (r as { data: { json: () => Promise<TransactionData> } }).data.json();
        return {
          id               : (r as { id: string }).id,
          type             : data.type,
          amount           : data.amount,
          unit             : data.unit,
          mintUrl          : data.mintUrl,
          status           : data.status,
          cashuToken       : data.cashuToken,
          recipientDid     : data.recipientDid,
          senderDid        : data.senderDid,
          memo             : data.memo,
          createdAt        : data.createdAt,
          invoice          : data.invoice,
          quoteId          : data.quoteId,
          expiresAt        : data.expiresAt,
        } satisfies Transaction;
      }));
      // Sort newest first
      txList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setTransactions(txList);
    } catch (err) {
      console.error('Failed to load transactions:', err);
      setDwnError('Failed to load wallet data. Check your connection.');
    }
  }, [repo]);

  const refreshPreferences = useCallback(async () => {
    if (!repo) return;
    try {
      const record = await repo.preference.get();
      if (record) {
        const data: PreferenceData = await record.data.json();
        setPreferences(data);
      }
    } catch (err) {
      // Expected: no preferences record exists yet on first launch
      console.warn('[nutsd] Preferences not found or unreadable (expected on first launch):', err);
    }
  }, [repo]);

  /** Publish the P2PK public key as a world-readable record in the
   *  cashu-transfer protocol so senders can discover it by DID. */
  const publishP2pkPublicKey = useCallback(async (publicKey: string) => {
    const transferTyped = transferTypedRef.current;
    if (!transferTyped) return;
    try {
      // Check if already published
      const { records } = await transferTyped.records.query('publicKey');
      if (records && records.length > 0) {
        console.log('[nutsd] P2PK public key already published');
        return;
      }
      const { record } = await transferTyped.records.create('publicKey', {
        data     : { publicKey, publishedAt: new Date().toISOString() },
        published: true,
      });
      if (record) {
        // Send to remote DWN so others can query it.
        // send() without a target sends to the connected DID's endpoints.
        await record.send().catch(() => {
          console.warn('[nutsd] Failed to send P2PK public key to remote DWN');
        });
        console.log('[nutsd] Published P2PK public key to DWN');
      }
    } catch (err) {
      console.warn('[nutsd] Failed to publish P2PK public key:', err);
    }
  }, []);

  /**
   * Load (or create) the P2PK keypair.
   *
   * SAFETY INVARIANT: once a key has been published (i.e. a publicKey
   * record exists in the transfer protocol), we MUST NOT generate a
   * replacement. Doing so would orphan the published pubkey — senders
   * would lock tokens to key A while the wallet holds key B.
   *
   * Failure modes:
   * 1. No private-key record AND no published key → first-time setup, generate.
   * 2. No private-key record BUT published key exists → key is lost/unreadable.
   *    Fail closed: log error, do NOT generate a new key.
   * 3. Private-key record exists but decrypt fails → encrypted record issue.
   *    Fail closed: log error, do NOT generate a new key.
   * 4. Private-key record exists and decrypts → happy path.
   */
  const loadP2pkKey = useCallback(async () => {
    if (!repo) return;
    const transferTyped = transferTypedRef.current;

    try {
      console.log('[nutsd] loadP2pkKey for DID:', connectedDid?.slice(0, 24) + '...');

      // Step 1: Try to read the encrypted private key from the wallet protocol.
      let record: any;
      let getError: unknown;
      try {
        record = await repo.p2pkKey.get();
      } catch (err) {
        getError = err;
      }

      // Case 4: record found — try to decrypt.
      if (record) {
        try {
          const data: P2pkKeyData = await record.data.json();
          setP2pkKey({ publicKey: data.publicKey, privateKey: data.privateKey });
          console.log('[nutsd] P2PK key loaded:', data.publicKey.slice(0, 12) + '...');
          publishP2pkPublicKey(data.publicKey);
          return;
        } catch (decryptErr) {
          // Case 3: record exists but can't be decrypted.
          console.error(
            '[nutsd] P2PK key record exists but cannot be decrypted.',
            'NOT generating a replacement — existing published key must be preserved.',
            decryptErr,
          );
          return;
        }
      }

      // Record not found (or query threw). Before generating a new key,
      // check whether a publicKey was ALREADY PUBLISHED in the transfer
      // protocol. If so, the wallet was previously initialized and the
      // private key is lost/unreadable — we must NOT silently rotate.
      let alreadyPublished = false;
      if (transferTyped) {
        try {
          const { records } = await transferTyped.records.query('publicKey');
          alreadyPublished = (records?.length ?? 0) > 0;
        } catch {
          // Query failure — conservative: assume not published.
        }
      }

      if (getError) {
        console.error('[nutsd] p2pkKey.get() threw:', getError);
      }

      if (alreadyPublished) {
        // Case 2: published key exists but private key is not readable.
        console.error(
          '[nutsd] P2PK public key is published but private key record was not found.',
          'NOT generating a replacement — existing senders may have locked tokens to the published key.',
          'Claiming existing P2PK transfers will not work until the key is recovered.',
        );
        return;
      }

      // Case 1: truly first-time setup — no published key, no private key.
      console.log('[nutsd] First-time P2PK key setup');
      const newKey = generateP2pkKeyPair();

      // CRITICAL: the private key MUST be durably stored BEFORE we publish
      // the public key or use the key in memory. If set() fails, we must
      // NOT publish — otherwise the published key has no recoverable
      // private key, and tokens locked to it are permanently unclaimable.
      try {
        await repo.p2pkKey.set({
          data: {
            publicKey  : newKey.publicKey,
            privateKey : newKey.privateKey,
            createdAt  : new Date().toISOString(),
          } satisfies P2pkKeyData,
        });
      } catch (setErr) {
        console.error(
          '[nutsd] p2pkKey.set() FAILED — key NOT persisted, NOT publishing.',
          'P2PK transfers will not work until the DWN write succeeds.',
          setErr,
        );
        // Do NOT setP2pkKey or publishP2pkPublicKey — the key is ephemeral
        // and would create an unrecoverable pubkey/privkey split on refresh.
        return;
      }

      // Private key is durably stored — safe to publish and use.
      console.log('[nutsd] P2PK key generated and stored:', newKey.publicKey.slice(0, 12) + '...');
      setP2pkKey(newKey);
      publishP2pkPublicKey(newKey.publicKey);
    } catch (err) {
      console.error('[nutsd] P2PK key load failed:', err);
    }
  }, [repo, connectedDid, publishP2pkPublicKey]);

  /**
   * Query the user's DWN for incoming transfer protocol records.
   *
   * Stores both the transfer data AND the DWN record reference so we can
   * delete the record after successful redemption (idempotency).
   */
  const checkIncomingTransfers = useCallback(async () => {
    const transferTyped = transferTypedRef.current;
    if (!transferTyped || !connectedDid) return;
    try {
      // Query local DWN (where sync should have pulled records)
      const localResult = await transferTyped.records.query('transfer');
      const localCount = localResult.records?.length ?? 0;

      // Also query remote DWN directly to verify the record exists there
      let remoteCount = 0;
      try {
        const remoteResult = await transferTyped.records.query('transfer', { from: connectedDid });
        remoteCount = remoteResult.records?.length ?? 0;
      } catch (remoteErr) {
        console.warn('[nutsd] Remote transfer query failed:', remoteErr);
      }

      console.log(`[nutsd] checkIncomingTransfers: local=${localCount}, remote=${remoteCount}`);

      const records = localResult.records;
      if (!records || records.length === 0) {
        setIncomingTransfers([]);
        return;
      }

      const transfers: Array<{ data: TransferData; record: any }> = [];
      for (const record of records) {
        try {
          const data: TransferData = await record.data.json();
          transfers.push({ data, record });
        } catch (err) {
            console.warn('[nutsd] Skipping unreadable incoming transfer record:', err);
          }
      }
      incomingTransferRecordsRef.current = transfers;
      setIncomingTransfers(transfers.map(t => t.data));
    } catch (err) {
      console.warn('[nutsd] Failed to check incoming transfers:', err);
    }
  }, [connectedDid]);

  // --- Initial load ---
  useEffect(() => {
    if (!repo) return;
    setLoading(true);
    Promise.all([refreshMints(), refreshTransactions(), refreshPreferences(), loadP2pkKey()])
      .finally(() => setLoading(false));
  }, [repo, refreshMints, refreshTransactions, refreshPreferences, loadP2pkKey]);

  // Proofs/keysets load after mints; startup recovery runs once proofs are loaded.
  const startupRecoveryDone = useRef(false);
  const startupRecoveryRef = useRef<(freshProofs: StoredProof[]) => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Load proofs and keysets (depend on mints being present)
      let freshProofs: StoredProof[] = [];
      if (mints.length > 0) {
        freshProofs = await refreshProofs();
        await refreshKeysets();
      }
      // Incoming transfers checked regardless of mint count
      await checkIncomingTransfers();

      // Startup recovery: runs ONCE, AFTER proofs are loaded.
      // Pass freshProofs directly — React state may not have committed yet.
      if (!cancelled && !startupRecoveryDone.current) {
        startupRecoveryDone.current = true;
        try {
          await startupRecoveryRef.current(freshProofs);
        } catch (err) {
          console.error('[nutsd] Startup recovery failed:', err);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [mints, refreshProofs, refreshKeysets, checkIncomingTransfers]);

  // --- Subscriptions ---
  const refreshRef = useRef<() => void>(() => {});

  // Live subscription for the WALLET protocol (proofs, mints, transactions).
  useEffect(() => {
    const typed = typedRef.current;
    if (!typed) return;

    let cleanup: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout>;

    typed.subscribe().then((liveQuery: { on: (event: string, cb: () => void) => () => void; close: () => void }) => {
      if (!liveQuery) return;

      const unsub = liveQuery.on('change', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refreshRef.current(), 300);
      });

      cleanup = () => {
        unsub();
        liveQuery.close();
      };
    }).catch((err: unknown) => console.error('Wallet protocol subscription failed:', err));

    return () => {
      clearTimeout(debounceTimer);
      cleanup?.();
    };
  }, [repo]);

  // Live subscription for the TRANSFER protocol (incoming P2PK transfers).
  // Without this, incoming transfers only appear on manual refresh.
  useEffect(() => {
    const transferTyped = transferTypedRef.current;
    if (!transferTyped) return;

    let cleanup: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout>;

    transferTyped.subscribe().then((liveQuery: { on: (event: string, cb: () => void) => () => void; close: () => void }) => {
      if (!liveQuery) return;

      const unsub = liveQuery.on('change', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          checkIncomingTransfers().catch(() => {});
        }, 300);
      });

      cleanup = () => {
        unsub();
        liveQuery.close();
      };
    }).catch((err: unknown) => {
      console.warn('[nutsd] Transfer protocol subscription failed:', err);
    });

    return () => {
      clearTimeout(debounceTimer);
      cleanup?.();
    };
  }, [repo, checkIncomingTransfers]);

  useEffect(() => {
    refreshRef.current = () => {
      refreshMints();
      refreshProofs();
      refreshKeysets();
      refreshTransactions();
      refreshPreferences();
    };
  }, [refreshMints, refreshProofs, refreshKeysets, refreshTransactions, refreshPreferences]);

  // =========================================================================
  // Background mint health polling (every 2 minutes)
  // =========================================================================

  useEffect(() => {
    if (mints.length === 0) return;

    let cancelled = false;
    const checkAll = async () => {
      const health = new Map<string, boolean>();
      for (const mint of mints) {
        try {
          await getMintInfo(mint.url, mint.unit);
          health.set(mint.contextId, true);
        } catch {
          // Expected: mint is offline or unreachable — recorded as unhealthy
          health.set(mint.contextId, false);
        }
      }
      if (!cancelled) setMintHealth(health);
    };

    checkAll(); // immediate check
    const interval = setInterval(checkAll, 120_000); // 2 minutes

    return () => { cancelled = true; clearInterval(interval); };
  }, [mints]);

  // =========================================================================
  // Computed values
  // =========================================================================

  /** Per-mint balances (only unspent proofs). */
  const mintBalances = useMemo(() => {
    const balances = new Map<string, number>();
    for (const mint of mints) {
      balances.set(mint.url, 0);
    }
    for (const proof of proofs) {
      if (proof.state !== 'unspent') continue;
      const current = balances.get(proof.mintUrl) ?? 0;
      balances.set(proof.mintUrl, current + proof.amount);
    }
    return balances;
  }, [mints, proofs]);

  /** Total balance across all mints. */
  const totalBalance = useMemo(() => {
    let total = 0;
    for (const balance of mintBalances.values()) {
      total += balance;
    }
    return total;
  }, [mintBalances]);

  /**
   * Per-mint input fee rate (max feePpk across active keysets for that mint).
   *
   * For display purposes, we use the maximum fee rate across all active keysets
   * at a mint. In practice, most mints have a single active keyset per unit.
   */
  const mintFeePpk = useMemo(() => {
    const fees = new Map<string, number>();
    for (const mint of mints) {
      const mintKeysets = keysets.filter(k => k.mintContextId === mint.contextId && k.active);
      const maxFee = mintKeysets.reduce((max, k) => Math.max(max, k.inputFeePpk), 0);
      fees.set(mint.url, maxFee);
    }
    return fees;
  }, [mints, keysets]);

  /**
   * Map of keyset ID -> inputFeePpk for all known keysets.
   * Used by `estimateInputFee()` for per-keyset fee calculation.
   */
  const keysetFeeMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const keyset of keysets) {
      map.set(keyset.keysetId, keyset.inputFeePpk);
    }
    return map;
  }, [keysets]);

  /** Per-unit balance totals across all mints. */
  const unitBalances = useMemo(() => {
    const balances = new Map<string, number>();
    for (const proof of proofs) {
      if (proof.state !== 'unspent') continue;
      const mint = mints.find(m => m.contextId === proof.mintContextId);
      const unit = mint?.unit ?? 'sat';
      balances.set(unit, (balances.get(unit) ?? 0) + proof.amount);
    }
    return balances;
  }, [mints, proofs]);

  /** Number of unspent proofs per mint URL. */
  const proofCountByMint = useMemo(() => {
    const counts = new Map<string, number>();
    for (const proof of proofs) {
      if (proof.state !== 'unspent') continue;
      counts.set(proof.mintUrl, (counts.get(proof.mintUrl) ?? 0) + 1);
    }
    return counts;
  }, [proofs]);

  // --- Context-aware selectors (for multi-unit mint correctness) ---
  // When the same mint URL exists with multiple units (e.g. sat + usd),
  // URL-keyed selectors above combine their data. These context-keyed
  // alternatives give per-mint-record accuracy.

  /** Per-mint-context balance (unspent proofs only). Keyed by contextId. */
  const mintBalancesByContext = useMemo(() => {
    const balances = new Map<string, number>();
    for (const mint of mints) {
      balances.set(mint.contextId, 0);
    }
    for (const proof of proofs) {
      if (proof.state !== 'unspent') continue;
      const current = balances.get(proof.mintContextId) ?? 0;
      balances.set(proof.mintContextId, current + proof.amount);
    }
    return balances;
  }, [mints, proofs]);

  /** Get unspent proofs for a specific mint context. */
  const getUnspentProofsByContext = useCallback((mintContextId: string): StoredProof[] => {
    return proofs.filter(p => p.state === 'unspent' && p.mintContextId === mintContextId);
  }, [proofs]);

  /** Number of pending proofs (for UI indicators). */
  const pendingProofCount = useMemo(
    () => proofs.filter(p => p.state === 'pending').length,
    [proofs],
  );

  // =========================================================================
  // Proof state management
  // =========================================================================

  /**
   * Update a single proof's state in the DWN and local state.
   *
   * Uses the cached DWN record reference for efficient in-place updates.
   */
  const updateProofState = useCallback(async (proofId: string, newState: ProofState) => {
    if (!repo) return;
    const record = proofRecordCache.current.get(proofId);
    if (!record) {
      console.warn(`[nutsd] Cannot update state: proof record ${proofId} not in cache`);
      return;
    }
    try {
      const data: ProofData = await record.data.json();
      await record.update({ data: { ...data, state: newState } });
      setProofs(prev => prev.map(p =>
        p.id === proofId ? { ...p, state: newState } : p,
      ));
    } catch (err) {
      console.error(`Failed to update proof state for ${proofId}:`, err);
      throw err;
    }
  }, [repo]);

  /**
   * Mark multiple proofs as `pending` in the DWN.
   *
   * MUST be called before any mint operation that sends these proofs.
   * If this fails, the caller should NOT proceed with the mint call.
   *
   * Updates are performed in parallel for speed, but all must succeed.
   */
  const markProofsPending = useCallback(async (proofIds: string[]) => {
    await Promise.all(proofIds.map(id => updateProofState(id, 'pending')));
  }, [updateProofState]);

  /**
   * Revert multiple proofs from `pending` back to `unspent`.
   *
   * Called when a mint operation fails and NUT-07 confirms the mint
   * has not consumed the proofs.
   */
  const revertProofsToUnspent = useCallback(async (proofIds: string[]) => {
    await Promise.all(proofIds.map(id => updateProofState(id, 'unspent')));
  }, [updateProofState]);

  /**
   * Reconcile all pending proofs with the mint on startup.
   *
   * For each mint with pending proofs:
   * 1. Check proof state via NUT-07 (`checkProofsStates`)
   * 2. UNSPENT at mint → revert to 'unspent' (operation failed/was rejected)
   * 3. SPENT at mint → delete (operation succeeded, but app crashed before cleanup)
   * 4. PENDING at mint → keep as 'pending' (mint is still processing)
   *
   * This is the crash recovery mechanism. Without it, proofs marked pending
   * before a crash would be stuck in limbo forever.
   */
  /**
   * @param loadedProofs - Pass freshly loaded proofs directly to avoid
   *   depending on React state (which may not have committed yet after
   *   setProofs). Falls back to the `proofs` state if not provided.
   */
  const reconcilePendingProofs = useCallback(async (loadedProofs?: StoredProof[]) => {
    const allProofs = loadedProofs ?? proofs;
    const pendingProofs = allProofs.filter(p => p.state === 'pending');
    if (pendingProofs.length === 0) return;

    setReconciling(true);
    console.log(`[nutsd] Reconciling ${pendingProofs.length} pending proof(s)...`);

    // Group pending proofs by mint URL
    const byMint = new Map<string, StoredProof[]>();
    for (const proof of pendingProofs) {
      const existing = byMint.get(proof.mintUrl) ?? [];
      existing.push(proof);
      byMint.set(proof.mintUrl, existing);
    }

    for (const [mintUrl, mintProofs] of byMint) {
      try {
        // Build cashu-ts Proof objects for NUT-07 check
        const cashuProofs: Proof[] = mintProofs.map(p => ({
          amount : p.amount,
          id     : p.keysetId,
          secret : p.secret,
          C      : p.C,
        }));

        // Use groupProofsByState which matches results by Y-value (the
        // public point of each proof's secret) instead of array index.
        // This is robust against response ordering differences.
        const grouped = await groupProofsByState(mintUrl, cashuProofs);

        // Build a secret → storedProof map for lookup
        const bySecret = new Map(mintProofs.map(p => [p.secret, p]));

        for (const proof of grouped.unspent) {
          const stored = bySecret.get(proof.secret);
          if (stored) {
            console.log(`[nutsd] Proof ${stored.id} is UNSPENT at mint, reverting`);
            await updateProofState(stored.id, 'unspent');
          }
        }

        for (const proof of grouped.spent) {
          const stored = bySecret.get(proof.secret);
          if (stored) {
            console.log(`[nutsd] Proof ${stored.id} is SPENT at mint, deleting`);
            await deleteProofById(stored.id);
          }
        }

        for (const proof of grouped.pending) {
          const stored = bySecret.get(proof.secret);
          if (stored) {
            console.log(`[nutsd] Proof ${stored.id} is PENDING at mint, keeping pending`);
          }
        }
      } catch (err) {
        // NUT-07 check failed (mint unreachable, etc.) — leave proofs as pending
        console.warn(`[nutsd] Reconciliation failed for mint ${mintUrl}:`, err);
      }
    }

    setReconciling(false);
    console.log('[nutsd] Reconciliation complete');
  }, [proofs, updateProofState]); // eslint-disable-line react-hooks/exhaustive-deps

  // =========================================================================
  // Mint CRUD
  // =========================================================================

  const addMint = useCallback(async (data: MintData): Promise<Mint | undefined> => {
    if (!repo) return;
    // Mint is unencrypted — tags are safe here (public info only)
    const { record } = await repo.mint.create({
      data,
      tags: { url: data.url, unit: data.unit },
    });
    if (!record) throw new Error('Failed to create mint record');
    const mint: Mint = {
      id        : record.id,
      contextId : record.contextId ?? record.id,
      url       : data.url,
      name      : data.name,
      unit      : data.unit,
      active    : data.active,
      info      : data.info,
    };
    setMints(prev => [...prev, mint]);

    // Fetch and store keyset records for the new mint
    try {
      await syncKeysetsForMint(mint);
    } catch (err) {
      console.warn(`[nutsd] Failed to fetch keysets for ${data.url}:`, err);
    }

    return mint;
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Update a mint's metadata (e.g., custom name). */
  const updateMint = useCallback(async (id: string, updates: Partial<MintData>) => {
    if (!repo) return;
    try {
      const { records } = await repo.mint.query();
      const record = records.find((r: { id: string }) => r.id === id);
      if (!record) return;
      const data: MintData = await record.data.json();
      await record.update({ data: { ...data, ...updates } });
      setMints(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
    } catch (err) {
      console.error('Failed to update mint:', err);
    }
  }, [repo]);

  /** Remove a mint and cascade-delete its child proofs and keysets. */
  const removeMint = useCallback(async (id: string) => {
    if (!repo) return;
    const mint = mints.find(m => m.id === id);
    if (mint) {
      try {
        const { records: proofRecords } = await repo.mint.proof.query(mint.contextId);
        for (const r of proofRecords) await r.delete();
      } catch (err) {
        console.warn('[nutsd] Failed to delete child proofs during mint removal (may have none):', err);
      }
      try {
        const { records: keysetRecords } = await repo.mint.keyset.query(mint.contextId);
        for (const r of keysetRecords) await r.delete();
      } catch (err) {
        console.warn('[nutsd] Failed to delete child keysets during mint removal (may have none):', err);
      }
    }
    await repo.mint.delete(id);
    setMints(prev => prev.filter(m => m.id !== id));
    setProofs(prev => prev.filter(p => p.mintContextId !== (mint?.contextId ?? id)));
    setKeysets(prev => prev.filter(k => k.mintContextId !== (mint?.contextId ?? id)));
  }, [repo, mints]);

  // =========================================================================
  // Keyset CRUD
  // =========================================================================

  /**
   * Sync keyset records for a mint with the mint's current keyset info.
   *
   * Fetches keyset metadata (id, unit, active, inputFeePpk) from the mint,
   * creates new DWN records for unknown keysets, and updates existing ones
   * if the active status or fee rate has changed.
   */
  const syncKeysetsForMint = useCallback(async (mint: Mint): Promise<void> => {
    if (!repo) return;

    // Fetch live keyset info from the mint
    let infos: KeysetInfo[];
    try {
      infos = await getKeysetInfos(mint.url, mint.unit);
    } catch (err) {
      console.warn(`[nutsd] Failed to fetch keyset info from ${mint.url}:`, err);
      return;
    }

    // Load existing stored keysets for this mint
    const { records: existingRecords } = await repo.mint.keyset.query(mint.contextId);
    const existingByKeysetId = new Map<string, any>();
    for (const r of existingRecords) {
      const data: KeysetData = await r.data.json();
      existingByKeysetId.set(data.keysetId, { record: r, data });
    }

    const newKeysets: Keyset[] = [];

    for (const info of infos) {
      const existing = existingByKeysetId.get(info.id);

      if (!existing) {
        // New keyset — create DWN record
        const data: KeysetData = {
          keysetId    : info.id,
          unit        : info.unit,
          active      : info.active,
          inputFeePpk : info.inputFeePpk,
        };
        const { record } = await repo.mint.keyset.create(mint.contextId, { data });
        if (record) {
          newKeysets.push({
            id            : record.id,
            contextId     : record.contextId ?? record.id,
            mintContextId : mint.contextId,
            keysetId      : info.id,
            unit          : info.unit,
            active        : info.active,
            inputFeePpk   : info.inputFeePpk,
          });
        }
      } else if (
        existing.data.active !== info.active ||
        existing.data.inputFeePpk !== info.inputFeePpk
      ) {
        // Existing keyset with changed metadata — update
        await existing.record.update({
          data: {
            ...existing.data,
            active      : info.active,
            inputFeePpk : info.inputFeePpk,
          },
        });
        newKeysets.push({
          id            : existing.record.id,
          contextId     : existing.record.contextId ?? existing.record.id,
          mintContextId : mint.contextId,
          keysetId      : info.id,
          unit          : info.unit,
          active        : info.active,
          inputFeePpk   : info.inputFeePpk,
        });
      } else {
        // Unchanged — keep as is
        newKeysets.push({
          id            : existing.record.id,
          contextId     : existing.record.contextId ?? existing.record.id,
          mintContextId : mint.contextId,
          keysetId      : existing.data.keysetId,
          unit          : existing.data.unit,
          active        : existing.data.active,
          inputFeePpk   : existing.data.inputFeePpk ?? 0,
        });
      }
    }

    // If any keysets were added or changed, evict the cashu-ts wallet cache
    // for this mint so it re-loads with fresh keyset data on next use.
    const hasNewOrChanged = newKeysets.some(nk => {
      const existed = existingByKeysetId.has(nk.keysetId);
      if (!existed) return true; // new keyset
      const old = existingByKeysetId.get(nk.keysetId)!.data;
      return old.active !== nk.active || old.inputFeePpk !== nk.inputFeePpk;
    });
    if (hasNewOrChanged) {
      evictWalletCache(mint.url, mint.unit);
    }

    // Update local state (merge with existing keysets for other mints)
    setKeysets(prev => [
      ...prev.filter(k => k.mintContextId !== mint.contextId),
      ...newKeysets,
    ]);
  }, [repo]);

  /**
   * Sync keysets for all mints.
   * Called on initial load and when mints change.
   */
  const syncAllKeysets = useCallback(async () => {
    for (const mint of mints) {
      await syncKeysetsForMint(mint);
    }
  }, [mints, syncKeysetsForMint]);

  // =========================================================================
  // Proof CRUD
  // =========================================================================
  // No tags on proof records — encrypted type.

  const addProof = useCallback(async (
    mintContextId: string,
    proofData: ProofData,
    state: ProofState = 'unspent',
  ): Promise<StoredProof | undefined> => {
    if (!repo) return;
    const mint = mints.find(m => m.contextId === mintContextId);
    // Persist state in the encrypted record data
    const dataWithState: ProofData = { ...proofData, state };
    const { record } = await repo.mint.proof.create(mintContextId, {
      data: dataWithState,
      // NO tags — encrypted record type. State tracked in data.
    });
    if (!record) throw new Error('Failed to store proof');
    // Cache the record for future state updates
    proofRecordCache.current.set(record.id, record);
    const stored: StoredProof = {
      id             : record.id,
      contextId      : record.contextId ?? record.id,
      mintContextId,
      mintUrl        : mint?.url ?? '',
      amount         : proofData.amount,
      keysetId       : proofData.id,
      secret         : proofData.secret,
      C              : proofData.C,
      state,
      dleq           : proofData.dleq,
      witness        : proofData.witness,
    };
    setProofs(prev => [...prev, stored]);
    return stored;
  }, [repo, mints]);

  /** Add multiple proofs at once (from mint/receive/swap). */
  const addProofs = useCallback(async (
    mintContextId: string,
    proofDataList: ProofData[],
    state: ProofState = 'unspent',
  ): Promise<void> => {
    for (const pd of proofDataList) {
      await addProof(mintContextId, pd, state);
    }
  }, [addProof]);

  /** Delete a proof record from the DWN. */
  const deleteProof = useCallback(async (id: string) => {
    if (!repo) return;
    await repo.mint.proof.delete(id);
    proofRecordCache.current.delete(id);
    setProofs(prev => prev.filter(p => p.id !== id));
  }, [repo]);

  /**
   * Delete a proof by ID (internal use for reconciliation).
   * Does not throw if the proof is already gone.
   */
  const deleteProofById = useCallback(async (id: string) => {
    try {
      await deleteProof(id);
    } catch (err) {
      console.warn(`[nutsd] Failed to delete proof ${id} (may already be gone):`, err);
    }
  }, [deleteProof]);

  /** Delete multiple proofs by their DWN record IDs. */
  const deleteProofs = useCallback(async (ids: string[]) => {
    for (const id of ids) {
      await deleteProof(id);
    }
  }, [deleteProof]);

  // =========================================================================
  // Crash-safe proof persistence (WAL pattern)
  // =========================================================================

  /**
   * Safely persist proofs received from a mint swap using a write-ahead stash.
   *
   * The mint swap is irreversible — once the mint accepts, the old proofs are
   * spent and the new proofs are the ONLY copy. If per-proof DWN writes fail,
   * those proofs are lost forever.
   *
   * This function writes a single "stash" record containing ALL proofs FIRST,
   * then writes individual proof records, then deletes the stash. If the app
   * crashes between the stash write and the final cleanup, `recoverProofStashes()`
   * on next startup replays the stash.
   *
   * @param mintContextId - DWN context ID of the mint (must exist)
   * @param mintUrl - Mint URL (for stash metadata)
   * @param unit - Currency unit
   * @param proofDataList - Full proof set from the mint swap
   * @returns `true` if all proofs were durably persisted and the stash was
   *   cleaned up. `false` if persistence was partial and the stash was
   *   preserved for later recovery. Callers MUST NOT treat `false` as
   *   "operation completed" — the proofs are safe (in the stash) but not
   *   yet individually queryable.
   */
  const safeStoreReceivedProofs = useCallback(async (
    mintContextId: string,
    mintUrl: string,
    unit: string,
    proofDataList: ProofData[],
  ): Promise<boolean> => {
    if (!repo) throw new Error('Repository not available');
    if (proofDataList.length === 0) return true;

    // STEP 1: Write stash record — single atomic DWN write.
    // This is the crash checkpoint. If this succeeds, we can always recover.
    const stashData: ProofStashData = {
      mintUrl,
      mintContextId,
      unit,
      proofs    : proofDataList,
      createdAt : new Date().toISOString(),
    };
    const { record: stashRecord } = await repo.proofStash.create({ data: stashData });
    if (!stashRecord) {
      throw new Error(
        'Failed to write proof stash. Proofs from this operation may not be ' +
        'persisted. Check your DWN connectivity and try again.',
      );
    }

    // STEP 2: Write individual proof records from the stash.
    // If this fails partway, the stash still has everything.
    try {
      for (const proofData of proofDataList) {
        await addProof(mintContextId, proofData);
      }
    } catch (err) {
      // Partial write — stash preserved for recovery on next startup.
      console.error(
        `[nutsd] Partial proof write failure (${proofDataList.length} proofs, stash preserved):`,
        err,
      );
      return false; // Stash preserved, but proofs NOT fully persisted
    }

    // STEP 3: All proofs written — delete the stash.
    try {
      await stashRecord.delete();
    } catch (err) {
      // Stash deletion failed — harmless. recoverProofStashes() cleans it up.
      console.warn('[nutsd:financial] Failed to delete proof stash (will clean up on next startup):', err);
    }
    return true; // All proofs durably persisted
  }, [repo, addProof]);

  /**
   * Recover any incomplete proof stashes on startup.
   *
   * For each stash:
   * 1. Ensure the mint record exists
   * 2. Load existing proofs for that mint
   * 3. For each proof in the stash, check if it was already written (dedup by secret)
   * 4. Write any missing proofs
   * 5. Delete the stash
   *
   * Delegates to the extracted `recoverStashes()` pure function (same code
   * that is tested in proof-stash-recovery.test.ts), wiring DWN access as
   * injected deps. This ensures the tested code IS the production code.
   */
  /** @returns true if any proofs were recovered (caller should re-load proofs). */
  const recoverProofStashes = useCallback(async (): Promise<boolean> => {
    if (!repo) return false;

    const deps: RecoveryDeps = {
      getStashes: async () => {
        const { records } = await repo.proofStash.query();
        if (!records) return [];
        const stashes = [];
        for (const record of records) {
          try {
            const data: ProofStashData = await record.data.json();
            stashes.push({ data, delete: () => record.delete() });
          } catch (err) {
              console.warn('[nutsd:financial] Skipping unreadable proof stash record:', err);
            }
        }
        return stashes;
      },
      getExistingSecrets: async (mintContextId: string) => {
        const secrets = new Set<string>();
        try {
          const { records: proofRecords } = await repo.mint.proof.query(mintContextId);
          for (const pr of proofRecords) {
            try {
              const pd: ProofData = await pr.data.json();
              secrets.add(pd.secret);
            } catch (err) {
              console.warn('[nutsd:financial] Skipping unreadable proof during secret dedup:', err);
            }
          }
        } catch (err) {
          console.warn('[nutsd:financial] No existing proofs for dedup (or query failed):', err);
        }
        return secrets;
      },
      writeProof: async (mintContextId: string, proof: ProofData) => {
        await addProof(mintContextId, proof);
      },
      ensureMint: async (mintUrl: string, unit: string) => {
        const mint = mints.find(m => m.url === mintUrl);
        if (!mint) {
          try {
            const newMint = await addMint({ url: mintUrl, unit, active: true });
            if (newMint) return newMint.contextId;
          } catch (err) {
            console.warn('[nutsd:financial] Mint unreachable during stash recovery:', err);
          }
          return null;
        }
        return mint.contextId;
      },
    };

    const result = await recoverStashes(deps);
    if (result.proofsRecovered > 0 || result.proofsFailed > 0) {
      console.log(
        `[nutsd] Stash recovery: ${result.proofsRecovered} recovered, ` +
        `${result.proofsFailed} failed, ${result.proofsSkipped} skipped, ` +
        `${result.stashesCompleted}/${result.stashesFound} stashes completed`,
      );
    }
    return result.proofsRecovered > 0;
  }, [repo, mints, addMint, addProof]);

  /**
   * Resume any pending cross-mint swaps (second leg: mint at trusted mint).
   * Scans transactions for status='pending' + type='swap' with PendingSwapState in memo.
   */
  const resumePendingSwaps = useCallback(async () => {
    if (!repo) return;
    try {
      const { records } = await repo.transaction.query();
      if (!records) return;

      for (const record of records) {
        try {
          const tx: TransactionData = await record.data.json();
          if (tx.status !== 'pending' || tx.type !== 'swap' || !tx.memo) continue;

          let swapState: PendingSwapState;
          try { swapState = JSON.parse(tx.memo); } catch {
            // Expected: memo is not a PendingSwapState JSON — this is a normal non-swap transaction
            continue;
          }
          if (!swapState.trustedMintQuoteId || !swapState.trustedMintUrl) continue;

          console.log(`[nutsd] Resuming pending swap: quote ${swapState.trustedMintQuoteId}`);
          const newProofs = await resumePendingSwap(swapState);

          if (newProofs.length > 0) {
            // CRITICAL: Ensure the trusted mint exists BEFORE persisting proofs.
            // mints[] may be empty on cold start. Auto-add if needed.
            let mint = mints.find(m => m.url === swapState.trustedMintUrl);
            if (!mint) {
              try {
                const added = await addMint({ url: swapState.trustedMintUrl, unit: swapState.unit, active: true });
                if (added) mint = added;
              } catch (err) {
                // Mint unreachable — do NOT mark completed. Leave pending for next startup.
                console.warn(`[nutsd:financial] Swap resume: trusted mint ${swapState.trustedMintUrl} unreachable, preserving pending state:`, err);
                continue;
              }
            }
            if (!mint) {
              // Still no mint — do NOT mark completed. Proofs would be lost.
              console.warn(`[nutsd] Swap resume: cannot resolve trusted mint, preserving pending state`);
              continue;
            }

            const fullyPersisted = await safeStoreReceivedProofs(
              mint.contextId, mint.url, mint.unit,
              newProofs.map(p => ({
                amount: p.amount, id: p.id, secret: p.secret, C: p.C, state: 'unspent' as const,
              })),
            );

            if (fullyPersisted) {
              // All proofs durably written — safe to mark completed.
              await record.update({ data: { ...tx, status: 'completed', memo: `Swap resumed: ${newProofs.length} proofs minted` } });
              console.log(`[nutsd] Pending swap completed: ${newProofs.length} proofs`);
            } else {
              // Proofs are in the stash but not fully persisted as individual records.
              // Do NOT mark completed — stash recovery on next startup will finish
              // the proof writes, and this resume will run again to mark completed.
              console.warn(`[nutsd] Swap proofs stashed but not fully persisted, keeping pending`);
            }
          } else {
            // resumePendingSwap returned empty proofs — quote was ISSUED (already
            // minted by a previous session/attempt). Two possibilities:
            //
            // 1. The previous attempt wrote a stash → stash recovery (which ran
            //    earlier in the startup sequence) already recovered the proofs.
            //    Proofs are in the local store. Marking completed is correct.
            //
            // 2. The previous attempt crashed before writing the stash (the
            //    documented ~ms pre-stash window). Proofs are unrecoverable —
            //    the mint won't re-issue, and no stash exists. Keeping this
            //    pending would just hit ISSUED on every startup forever with
            //    no recovery path. Marking completed is the honest outcome.
            //
            // In both cases, marking completed is correct. The stash is the
            // safety net, and it already ran before we got here.
            await record.update({ data: { ...tx, status: 'completed', memo: 'Swap completed (ISSUED — proofs recovered via stash or in pre-stash loss window)' } });
            console.log(`[nutsd] Pending swap ISSUED: ${swapState.trustedMintQuoteId} — proofs should have been recovered by stash recovery`);
          }
        } catch (err) {
          // Leave for next startup — the quote may still settle
          console.warn('[nutsd] Pending swap resume failed (will retry):', err);
        }
      }
    } catch (err) {
      console.error('[nutsd] Pending swap scan failed:', err);
    }
  }, [repo, mints, addMint, safeStoreReceivedProofs]);

  /**
   * Resume any pending mint-quote receives (Lightning receive, LNURL-withdraw).
   * Scans transactions for status='pending' + type='mint' with PendingMintState in memo.
   */
  const resumePendingReceives = useCallback(async (): Promise<boolean> => {
    if (!repo) return false;
    let recovered = false;
    try {
      const { records } = await repo.transaction.query();
      if (!records) return false;

      for (const record of records) {
        try {
          const tx: TransactionData = await record.data.json();
          if (tx.status !== 'pending' || tx.type !== 'mint' || !tx.memo) continue;

          const state = parsePendingMintState(tx.memo);
          if (!state) continue;

          console.log(`[nutsd] Resuming pending ${state.source} receive: quote ${state.quoteId}`);
          const result = await resumePendingMint(state);

          switch (result.status) {
            case 'minted': {
              // Ensure mint exists
              let mint = mints.find(m => m.contextId === state.mintContextId);
              if (!mint) {
                try {
                  const added = await addMint({ url: state.mintUrl, unit: state.unit, active: true });
                  if (added) mint = added;
                } catch {
                  console.warn(`[nutsd] Receive resume: mint ${state.mintUrl} unreachable, preserving pending`);
                  continue;
                }
              }
              if (!mint) {
                console.warn(`[nutsd] Receive resume: cannot resolve mint, preserving pending`);
                continue;
              }

              const fullyPersisted = await safeStoreReceivedProofs(
                mint.contextId, mint.url, mint.unit,
                result.proofs.map(p => ({
                  amount: p.amount, id: p.id, secret: p.secret, C: p.C, state: 'unspent' as const,
                })),
              );

              if (fullyPersisted) {
                const total = result.proofs.reduce((s, p) => s + p.amount, 0);
                await record.update({
                  data: { ...tx, status: 'completed', amount: total, memo: `Recovered ${state.source} receive` },
                });
                console.log(`[nutsd] Pending ${state.source} receive completed: ${total} ${state.unit}`);
                recovered = true;
              }
              break;
            }
            case 'issued':
              // ISSUED = tokens were already minted by a previous attempt.
              //
              // IMPORTANT: This does NOT guarantee the proofs are in the
              // local wallet. There is a pre-stash crash window where
              // mintTokens() succeeded but the app crashed before the WAL
              // stash write. In that case proofs are unrecoverable — the
              // mint won't re-issue, and no stash exists to recover from.
              //
              // The stash recovery step ran earlier in the startup sequence.
              // If a stash exists, those proofs are already recovered. If
              // no stash exists, the proofs fell into the ~ms pre-stash
              // window and are lost. Keeping this pending would just hit
              // ISSUED forever with no recovery path — marking completed
              // (with a warning) is the honest outcome.
              await record.update({
                data: {
                  ...tx,
                  status: 'completed',
                  memo: 'Recovered (ISSUED — proofs may have been recovered via stash, or lost in pre-stash crash window)',
                },
              });
              console.warn(
                `[nutsd:financial] Pending receive ISSUED: ${state.quoteId} — ` +
                'proofs should have been recovered by stash recovery; if not, ' +
                'they fell into the pre-stash crash window and are unrecoverable.',
              );
              recovered = true;
              break;
            case 'expired':
              await record.update({ data: { ...tx, status: 'failed', memo: 'Quote expired before payment' } });
              console.log(`[nutsd] Pending receive expired: ${state.quoteId}`);
              break;
            case 'pending':
              // Still waiting — leave for next startup
              break;
            case 'error':
              console.warn(`[nutsd] Pending receive check failed (will retry): ${result.message}`);
              break;
          }
        } catch (err) {
          console.warn('[nutsd] Pending receive resume failed (will retry):', err);
        }
      }
    } catch (err) {
      console.error('[nutsd] Pending receive scan failed:', err);
    }
    return recovered;
  }, [repo, mints, addMint, safeStoreReceivedProofs]);

  // Wire startup recovery ref — called by the mints-dependent effect above
  // AFTER proofs are loaded. The loaded proofs are passed directly to avoid
  // depending on React state (setProofs is async and may not have committed).
  useEffect(() => {
    startupRecoveryRef.current = async (freshProofs: StoredProof[]) => {
      const stashResult = await recoverProofStashes();
      // Resume any pending cross-mint swaps (second leg).
      await resumePendingSwaps();
      // Resume any pending Lightning / LNURL-withdraw receives.
      const receiveResult = await resumePendingReceives();
      // If any recovery wrote new proofs, re-load.
      const proofsForReconciliation = (stashResult || receiveResult)
        ? await refreshProofs()
        : freshProofs;
      await reconcilePendingProofs(proofsForReconciliation);
    };
  }, [recoverProofStashes, resumePendingSwaps, resumePendingReceives, refreshProofs, reconcilePendingProofs]);

  // =========================================================================
  // Transaction CRUD
  // =========================================================================
  // No tags on transaction records — encrypted type.

  const addTransaction = useCallback(async (data: TransactionData): Promise<Transaction | undefined> => {
    if (!repo) return;
    const { record } = await repo.transaction.create({
      data,
      // NO tags — encrypted record type.
    });
    if (!record) throw new Error('Failed to create transaction');
    const tx: Transaction = {
      id               : record.id,
      type             : data.type,
      amount           : data.amount,
      unit             : data.unit,
      mintUrl          : data.mintUrl,
      status           : data.status,
      claimStatus      : data.claimStatus,
      claimedAt        : data.claimedAt,
      cashuToken       : data.cashuToken,
      recipientDid     : data.recipientDid,
      senderDid        : data.senderDid,
      memo             : data.memo,
      createdAt        : data.createdAt,
      invoice          : data.invoice,
      quoteId          : data.quoteId,
      expiresAt        : data.expiresAt,
    };
    setTransactions(prev => [tx, ...prev]);
    return tx;
  }, [repo]);

  /**
   * Complete a pending transaction (e.g. after a mint quote is paid).
   * Updates status to 'completed', clears the pending-state memo, and
   * optionally updates the amount (useful when final amount differs).
   */
  const completeTransaction = useCallback(async (
    txId: string,
    opts?: { amount?: number; memo?: string },
  ) => {
    if (!repo) return;
    try {
      const { records } = await repo.transaction.query();
      const record = records.find((r: { id: string }) => r.id === txId);
      if (record) {
        const data: TransactionData = await record.data.json();
        await record.update({
          data: {
            ...data,
            status: 'completed',
            amount: opts?.amount ?? data.amount,
            memo: opts?.memo ?? undefined,
            // Clear pending invoice fields on completion
            invoice: undefined,
            quoteId: undefined,
          },
        });
        setTransactions(prev =>
          prev.map(t => t.id === txId ? {
            ...t,
            status: 'completed' as const,
            amount: opts?.amount ?? t.amount,
            memo: opts?.memo ?? undefined,
            invoice: undefined,
            quoteId: undefined,
          } : t),
        );
      }
    } catch (err) {
      console.warn('[nutsd] Failed to complete transaction:', err);
    }
  }, [repo]);

  /**
   * Delete a transaction record from DWN and local state.
   * Only allowed for expired pending invoices — callers should enforce policy.
   */
  const deleteTransaction = useCallback(async (txId: string) => {
    if (!repo) throw new Error('Wallet not initialized');
    const { records } = await repo.transaction.query();
    const record = records.find((r: { id: string }) => r.id === txId);
    if (!record) throw new Error('Transaction not found');
    await record.delete();
    setTransactions(prev => prev.filter(t => t.id !== txId));
  }, [repo]);

  /** Mark a pending transaction as failed (e.g. expired invoice). Internal helper. */
  const _markTransactionFailed = useCallback(async (txId: string, memo: string) => {
    if (!repo) return;
    try {
      const { records } = await repo.transaction.query();
      const record = records.find((r: { id: string }) => r.id === txId);
      if (record) {
        const data: TransactionData = await record.data.json();
        await record.update({
          data: { ...data, status: 'failed', memo, invoice: undefined, quoteId: undefined },
        });
        setTransactions(prev =>
          prev.map(t => t.id === txId
            ? { ...t, status: 'failed' as const, memo, invoice: undefined, quoteId: undefined }
            : t),
        );
      }
    } catch (err) {
      console.warn('[nutsd] Failed to mark transaction failed:', err);
    }
  }, [repo]);

  /**
   * Mark a sent transaction as claimed by the recipient.
   * Clears the cashuToken (no longer needed) and sets claimStatus/claimedAt.
   */
  const markTransactionClaimed = useCallback(async (txId: string) => {
    if (!repo) return;
    try {
      const { records } = await repo.transaction.query();
      const record = records.find((r: { id: string }) => r.id === txId);
      if (record) {
        const data: TransactionData = await record.data.json();
        const claimedAt = new Date().toISOString();
        await record.update({
          data: {
            ...data,
            cashuToken  : undefined,
            claimStatus : 'claimed',
            claimedAt,
          },
        });
        setTransactions(prev =>
          prev.map(t => t.id === txId
            ? { ...t, cashuToken: undefined, claimStatus: 'claimed', claimedAt }
            : t,
          ),
        );
      }
    } catch (err) {
      console.warn('Failed to mark transaction claimed:', err);
    }
  }, [repo]);

  // =========================================================================
  // Background token sweep (NUT-07)
  // =========================================================================
  // Periodically check if sent tokens have been claimed. For each 'send' or
  // 'p2p-send' transaction with a cashuToken, check if the token is spent.
  // If so, clear the cashuToken field. Runs every 5 minutes.

  useEffect(() => {
    if (!repo || transactions.length === 0) return;
    let cancelled = false;

    const sweep = async (): Promise<void> => {
      const { checkTokenSpent } = await import('@/cashu/wallet-ops');
      for (const tx of transactions) {
        if (cancelled) break;
        if (tx.type !== 'send' && tx.type !== 'p2p-send') continue;
        if (tx.claimStatus === 'claimed') continue; // already confirmed
        if (!tx.cashuToken) continue;
        try {
          const isSpent = await checkTokenSpent(tx.cashuToken, tx.mintUrl, tx.unit);
          if (isSpent === true) {
            await markTransactionClaimed(tx.id);
          }
        } catch { /* skip — mint may be offline */ }
      }
    };

    const timer = setInterval(sweep, 60 * 1000); // 1 minute — faster feedback
    // Also run once after a short delay (give initial load time to complete)
    const initialTimer = setTimeout(sweep, 10_000);

    return () => { cancelled = true; clearInterval(timer); clearTimeout(initialTimer); };
  }, [repo, transactions, markTransactionClaimed]);

  // =========================================================================
  // Background pending-invoice sweep
  // =========================================================================
  // Periodically check if pending Lightning invoices have been paid. This
  // covers the case where a user generates an invoice, closes the receive
  // dialog, and the payer pays while the app is still open. Without this,
  // settlement only happens on the next app restart.

  useEffect(() => {
    if (!repo || transactions.length === 0) return;
    // Only sweep if there are active pending invoices
    const pendingInvoices = transactions.filter(
      tx => tx.type === 'mint' && tx.status === 'pending' && tx.quoteId && tx.memo,
    );
    if (pendingInvoices.length === 0) return;
    let cancelled = false;

    const sweep = async (): Promise<void> => {
      for (const tx of pendingInvoices) {
        if (cancelled) break;
        // Skip expired invoices — no need to poll
        if (tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now()) continue;

        const state = parsePendingMintState(tx.memo!);
        if (!state) continue;

        try {
          const result = await resumePendingMint(state);
          if (cancelled) break;

          switch (result.status) {
            case 'minted': {
              const mint = mints.find(m => m.contextId === state.mintContextId)
                ?? mints.find(m => m.url === state.mintUrl);
              if (!mint) {
                console.warn(`[nutsd] Background sweep: unknown mint ${state.mintUrl}`);
                break;
              }
              await safeStoreReceivedProofs(
                mint.contextId, mint.url, mint.unit,
                result.proofs.map(p => ({
                  amount: p.amount, id: p.id, secret: p.secret, C: p.C, state: 'unspent' as const,
                })),
              );
              const total = result.proofs.reduce((s, p) => s + p.amount, 0);
              await completeTransaction(tx.id, { amount: total, memo: `Lightning receive` });
              await refreshProofs();
              toastSuccess('Payment received!', `+${formatAmount(total, mint.unit)}`);
              console.log(`[nutsd] Background sweep settled invoice: ${total} ${mint.unit}`);
              break;
            }
            case 'issued':
              await completeTransaction(tx.id, { memo: 'Lightning receive (already minted)' });
              console.warn(`[nutsd] Background sweep: invoice ISSUED (already minted): ${state.quoteId}`);
              break;
            case 'expired':
              // Update status so UI shows it as failed
              await _markTransactionFailed(tx.id, 'Quote expired before payment');
              break;
            case 'pending':
              break; // still waiting
            case 'error':
              break; // skip, try again next sweep
          }
        } catch {
          // skip — mint may be offline
        }
      }
    };

    const timer = setInterval(sweep, 15_000); // 15 seconds — invoices are time-sensitive
    const initialTimer = setTimeout(sweep, 5_000);

    return () => { cancelled = true; clearInterval(timer); clearTimeout(initialTimer); };
  }, [repo, transactions, mints, safeStoreReceivedProofs, completeTransaction, _markTransactionFailed, refreshProofs]);

  // =========================================================================
  // Incoming P2P transfers
  // =========================================================================

  /**
   * Redeem an incoming P2PK-locked transfer.
   *
   * SAFETY: Ensures the mint is known (auto-adds if reachable) BEFORE
   * redeeming. This prevents the fund-loss scenario where proofs are
   * redeemed from the mint but never persisted because no local mint
   * record exists.
   *
   * After successful redemption, deletes the transfer record from the DWN
   * so it does not reappear on the next startup (idempotency).
   */
  const redeemIncomingTransfer = useCallback(async (transfer: TransferData) => {
    if (!p2pkKey?.privateKey) {
      throw new Error('Cannot redeem P2PK transfer: no private key available');
    }

    const releaseLock = await acquireWalletLock('p2p-redeem');
    try {
      return await _redeemIncomingTransferInner(transfer);
    } finally {
      releaseLock();
    }
  }, [p2pkKey, mints, addMint, safeStoreReceivedProofs, addTransaction]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Inner redeem logic (called under lock). */
  const _redeemIncomingTransferInner = useCallback(async (transfer: TransferData) => {
    if (!p2pkKey?.privateKey) {
      throw new Error('Cannot redeem P2PK transfer: no private key available');
    }

    // STEP 1: Ensure the mint is known. If not, auto-add it.
    // This MUST happen before redemption to guarantee proofs can be persisted.
    let mint = mints.find(m => m.url === transfer.mintUrl);
    if (!mint) {
      // Auto-add the mint. If unreachable, this throws and we do NOT redeem.
      const newMint = await addMint({
        url    : transfer.mintUrl,
        unit   : transfer.unit,
        active : true,
      });
      if (!newMint) {
        throw new Error(
          `Cannot redeem: mint ${transfer.mintUrl} is unreachable. ` +
          'Add the mint manually first, then try again.',
        );
      }
      mint = newMint;
    }

    // STEP 2: Redeem the P2PK-locked token with the mint.
    const newProofs = await receiveP2pkLocked(
      transfer.mintUrl, transfer.token, p2pkKey.privateKey, transfer.unit,
    );

    // STEP 3: Persist the fresh proofs using the crash-safe stash pattern.
    // The mint has already issued them — these are the ONLY copy.
    // safeStoreReceivedProofs writes a stash first, then individual records.
    const proofDataList: ProofData[] = newProofs.map(proof => ({
      amount  : proof.amount,
      id      : proof.id,
      secret  : proof.secret,
      C       : proof.C,
      state   : 'unspent' as const,
      dleq    : proof.dleq ? { e: String(proof.dleq.e), s: String(proof.dleq.s), r: String(proof.dleq.r) } : undefined,
      witness : proof.witness ? (typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness)) : undefined,
    }));
    await safeStoreReceivedProofs(mint.contextId, transfer.mintUrl, transfer.unit, proofDataList);

    // STEP 4: Record the transaction.
    const totalReceived = newProofs.reduce((s, p) => s + p.amount, 0);
    await addTransaction({
      type       : 'p2p-receive',
      amount     : totalReceived,
      unit       : transfer.unit,
      mintUrl    : transfer.mintUrl,
      status     : 'completed',
      senderDid  : transfer.senderDid,
      memo       : transfer.memo,
      createdAt  : new Date().toISOString(),
    });

    // STEP 5: Delete the transfer record from the DWN so it does not
    // come back on the next startup. This is best-effort — if deletion
    // fails, the user will see the transfer again but the re-claim
    // attempt will fail at the mint (tokens already swapped).
    // Match by token content (not array index) to avoid stale-index bugs
    // when checkIncomingTransfers refreshes the array concurrently.
    try {
      const transferEntry = incomingTransferRecordsRef.current.find(
        (e) => e.data.token === transfer.token,
      );
      if (transferEntry?.record) {
        await transferEntry.record.delete();
      }
    } catch (err) {
      console.warn('[nutsd] Failed to delete claimed transfer record:', err);
    }

    // STEP 6: Remove from local UI state by token match (not index).
    incomingTransferRecordsRef.current = incomingTransferRecordsRef.current.filter(
      (e) => e.data.token !== transfer.token,
    );
    setIncomingTransfers(prev => prev.filter((t) => t.token !== transfer.token));
  }, [p2pkKey, mints, addMint, safeStoreReceivedProofs, addTransaction]);

  // =========================================================================
  // Preferences
  // =========================================================================

  const updatePreferences = useCallback(async (data: PreferenceData) => {
    if (!repo) return;
    await repo.preference.set({ data });
    setPreferences(data);
  }, [repo]);

  // =========================================================================
  // Derived helpers
  // =========================================================================

  /** Get unspent proofs for a specific mint. */
  const getUnspentProofsForMint = useCallback((mintUrl: string): StoredProof[] => {
    return proofs.filter(p => p.state === 'unspent' && p.mintUrl === mintUrl);
  }, [proofs]);

  /**
   * Get the maximum input fee rate (ppk) for a mint.
   * Returns 0 if no keyset info is available.
   */
  const getInputFeeForMint = useCallback((mintUrl: string): number => {
    return mintFeePpk.get(mintUrl) ?? 0;
  }, [mintFeePpk]);

  return {
    // State
    mints,
    proofs,
    keysets,
    transactions,
    preferences,
    p2pkKey,
    loading,
    reconciling,
    dwnError,
    totalBalance,
    mintBalances,
    mintBalancesByContext,
    unitBalances,
    proofCountByMint,
    mintFeePpk,
    keysetFeeMap,
    pendingProofCount,
    mintHealth,

    // Mint operations
    addMint,
    updateMint,
    removeMint,
    refreshMints,

    // Keyset operations
    refreshKeysets,
    syncKeysetsForMint,
    syncAllKeysets,

    // Proof operations
    addProof,
    addProofs,
    deleteProof,
    deleteProofs,
    refreshProofs,
    getUnspentProofsForMint,
    getUnspentProofsByContext,

    // Proof state tracking
    markProofsPending,
    revertProofsToUnspent,
    reconcilePendingProofs,

    // Crash-safe proof persistence
    safeStoreReceivedProofs,
    recoverProofStashes,

    // Fee helpers
    getInputFeeForMint,

    // Transaction operations
    addTransaction,
    completeTransaction,
    deleteTransaction,
    markTransactionClaimed,
    refreshTransactions,

    // Preferences
    updatePreferences,

    // Incoming P2P transfers
    incomingTransfers,
    checkIncomingTransfers,
    redeemIncomingTransfer,

    // Repo access for advanced operations
    repo,
  };
}
