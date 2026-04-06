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
import { repository } from '@enbox/api';
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
import {
  checkProofsState,
  getKeysetInfos,
  type KeysetInfo,
} from '@/cashu/wallet-ops';
import { generateP2pkKeyPair, receiveP2pkLocked, type P2pkKeyPair } from '@/cashu/p2pk';
import { recoverStashes, type RecoveryDeps } from '@/cashu/proof-stash-recovery';
import { acquireWalletLock } from '@/lib/wallet-mutex';

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
  /** Encrypted cashu token for sends. Cleared once confirmed spent. */
  cashuToken?: string;
  recipientDid?: string;
  senderDid?: string;
  memo?: string;
  createdAt: string;
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
  const { enbox, isConnected } = useEnbox();

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

  // --- DWN record cache (for in-place updates) ---
  const proofRecordCache = useRef<Map<string, any>>(new Map());
  // --- Transfer record cache (for deletion after redemption) ---
  const incomingTransferRecordsRef = useRef<Array<{ data: TransferData; record: any }>>([]);

  // Initialize repo when connected, install protocol
  useEffect(() => {
    if (enbox && isConnected) {
      const typed = enbox.using(CashuWalletProtocol);
      typedRef.current = typed;
      const r = repository(typed);
      setRepo(r);
      // Install protocol on the local DWN (idempotent if already installed)
      r.configure().catch((err: unknown) =>
        console.warn('[nutsd] Protocol configure (may already exist):', err),
      );

      // Install transfer protocol (idempotent)
      const transferTyped = enbox.using(CashuTransferProtocol);
      transferTypedRef.current = transferTyped;
      const transferRepo = repository(transferTyped);
      transferRepo.configure().catch((err: unknown) =>
        console.warn('[nutsd] Transfer protocol configure:', err),
      );
    } else {
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
      proofRecordCache.current.clear();
      incomingTransferRecordsRef.current = [];
      // Reset startup recovery flag so reconnection triggers fresh recovery
      startupRecoveryDone.current = false;
    }
  }, [enbox, isConnected]);

  // =========================================================================
  // Refresh functions
  // =========================================================================

  const refreshMints = useCallback(async () => {
    if (!repo) return;
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
      return [];
    }
  }, [repo, mints]);

  const refreshKeysets = useCallback(async () => {
    if (!repo || mints.length === 0) {
      setKeysets([]);
      return;
    }
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
    }
  }, [repo, mints]);

  const refreshTransactions = useCallback(async () => {
    if (!repo) return;
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
        } satisfies Transaction;
      }));
      // Sort newest first
      txList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setTransactions(txList);
    } catch (err) {
      console.error('Failed to load transactions:', err);
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
    } catch {
      // No preferences set yet
    }
  }, [repo]);

  const loadP2pkKey = useCallback(async () => {
    if (!repo) return;
    try {
      const record = await repo.p2pkKey.get();
      if (record) {
        const data: P2pkKeyData = await record.data.json();
        setP2pkKey({ publicKey: data.publicKey, privateKey: data.privateKey });
        return;
      }
      // Generate new key and store it
      const newKey = generateP2pkKeyPair();
      await repo.p2pkKey.set({
        data: {
          publicKey  : newKey.publicKey,
          privateKey : newKey.privateKey,
          createdAt  : new Date().toISOString(),
        } satisfies P2pkKeyData,
      });
      setP2pkKey(newKey);
      console.log('[nutsd] Generated new P2PK key:', newKey.publicKey.slice(0, 12) + '...');
    } catch (err) {
      console.error('Failed to load/create P2PK key:', err);
    }
  }, [repo]);

  /**
   * Query the user's DWN for incoming transfer protocol records.
   *
   * Stores both the transfer data AND the DWN record reference so we can
   * delete the record after successful redemption (idempotency).
   */
  const checkIncomingTransfers = useCallback(async () => {
    const transferTyped = transferTypedRef.current;
    if (!transferTyped) return;
    try {
      const { records } = await transferTyped.records.query({
        protocolPath: 'transfer',
      });
      if (!records || records.length === 0) {
        setIncomingTransfers([]);
        return;
      }

      const transfers: Array<{ data: TransferData; record: any }> = [];
      for (const record of records) {
        try {
          const data: TransferData = await record.data.json();
          transfers.push({ data, record });
        } catch { /* skip unreadable records */ }
      }
      incomingTransferRecordsRef.current = transfers;
      setIncomingTransfers(transfers.map(t => t.data));
    } catch (err) {
      console.warn('[nutsd] Failed to check incoming transfers:', err);
    }
  }, []);

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
        const cashuProofs = mintProofs.map(p => ({
          amount : p.amount,
          id     : p.keysetId,
          secret : p.secret,
          C      : p.C,
        }));

        const states = await checkProofsState(mintUrl, cashuProofs);

        // Match NUT-07 results to our stored proofs by index
        for (let i = 0; i < mintProofs.length; i++) {
          const storedProof = mintProofs[i];
          const mintState = states[i]?.state;

          if (mintState === 'UNSPENT') {
            // Mint says it's unspent → the operation was rejected or never reached the mint
            console.log(`[nutsd] Proof ${storedProof.id} is UNSPENT at mint, reverting`);
            await updateProofState(storedProof.id, 'unspent');
          } else if (mintState === 'SPENT') {
            // Mint says it's spent → operation succeeded but we crashed before cleanup
            console.log(`[nutsd] Proof ${storedProof.id} is SPENT at mint, deleting`);
            await deleteProofById(storedProof.id);
          } else if (mintState === 'PENDING') {
            // Mint is still processing → leave as pending, user will need to check again
            console.log(`[nutsd] Proof ${storedProof.id} is PENDING at mint, keeping pending`);
          } else {
            // Unknown state — leave as is, log warning
            console.warn(`[nutsd] Proof ${storedProof.id} has unknown mint state: ${mintState}`);
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

  /** Remove a mint and cascade-delete its child proofs and keysets. */
  const removeMint = useCallback(async (id: string) => {
    if (!repo) return;
    const mint = mints.find(m => m.id === id);
    if (mint) {
      try {
        const { records: proofRecords } = await repo.mint.proof.query(mint.contextId);
        for (const r of proofRecords) await r.delete();
      } catch { /* no proofs to delete */ }
      try {
        const { records: keysetRecords } = await repo.mint.keyset.query(mint.contextId);
        for (const r of keysetRecords) await r.delete();
      } catch { /* no keysets to delete */ }
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
   */
  const safeStoreReceivedProofs = useCallback(async (
    mintContextId: string,
    mintUrl: string,
    unit: string,
    proofDataList: ProofData[],
  ): Promise<void> => {
    if (!repo) throw new Error('Repository not available');
    if (proofDataList.length === 0) return;

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
      return; // Do NOT delete the stash
    }

    // STEP 3: All proofs written — delete the stash.
    try {
      await stashRecord.delete();
    } catch {
      // Stash deletion failed — harmless. recoverProofStashes() cleans it up.
      console.warn('[nutsd] Failed to delete proof stash (will clean up on next startup)');
    }
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
          } catch { /* skip unreadable */ }
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
            } catch { /* skip */ }
          }
        } catch { /* no existing proofs */ }
        return secrets;
      },
      writeProof: async (mintContextId: string, proof: ProofData) => {
        await addProof(mintContextId, proof);
      },
      ensureMint: async (mintUrl: string, unit: string) => {
        let mint = mints.find(m => m.url === mintUrl);
        if (!mint) {
          try {
            const newMint = await addMint({ url: mintUrl, unit, active: true });
            if (newMint) return newMint.contextId;
          } catch { /* unreachable */ }
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

  // Wire startup recovery ref — called by the mints-dependent effect above
  // AFTER proofs are loaded. The loaded proofs are passed directly to avoid
  // depending on React state (setProofs is async and may not have committed).
  useEffect(() => {
    startupRecoveryRef.current = async (freshProofs: StoredProof[]) => {
      const stashResult = await recoverProofStashes();
      // If stash recovery wrote new proofs, re-load so reconciliation sees them.
      // Otherwise use the pre-loaded snapshot (avoids an extra DWN round-trip).
      const proofsForReconciliation = stashResult
        ? await refreshProofs()
        : freshProofs;
      await reconcilePendingProofs(proofsForReconciliation);
    };
  }, [recoverProofStashes, refreshProofs, reconcilePendingProofs]);

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
      cashuToken       : data.cashuToken,
      recipientDid     : data.recipientDid,
      senderDid        : data.senderDid,
      memo             : data.memo,
      createdAt        : data.createdAt,
    };
    setTransactions(prev => [tx, ...prev]);
    return tx;
  }, [repo]);

  /**
   * Clear the cashuToken from a sent transaction after confirming it's spent.
   * The token is no longer needed once the recipient has claimed it.
   */
  const clearTransactionToken = useCallback(async (txId: string) => {
    if (!repo) return;
    try {
      const { records } = await repo.transaction.query();
      const record = records.find((r: { id: string }) => r.id === txId);
      if (record) {
        const data: TransactionData = await record.data.json();
        await record.update({ data: { ...data, cashuToken: undefined } });
        setTransactions(prev =>
          prev.map(t => t.id === txId ? { ...t, cashuToken: undefined } : t),
        );
      }
    } catch (err) {
      console.warn('Failed to clear transaction token:', err);
    }
  }, [repo]);

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
  const redeemIncomingTransfer = useCallback(async (transfer: TransferData, index: number) => {
    if (!p2pkKey?.privateKey) {
      throw new Error('Cannot redeem P2PK transfer: no private key available');
    }

    const releaseLock = await acquireWalletLock('p2p-redeem');
    try {
      return await _redeemIncomingTransferInner(transfer, index);
    } finally {
      releaseLock();
    }
  }, [p2pkKey, mints, addMint, safeStoreReceivedProofs, addTransaction]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Inner redeem logic (called under lock). */
  const _redeemIncomingTransferInner = useCallback(async (transfer: TransferData, index: number) => {
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
    try {
      const transferEntry = incomingTransferRecordsRef.current[index];
      if (transferEntry?.record) {
        await transferEntry.record.delete();
      }
    } catch (err) {
      console.warn('[nutsd] Failed to delete claimed transfer record:', err);
    }

    // STEP 6: Remove from local UI state.
    incomingTransferRecordsRef.current = incomingTransferRecordsRef.current.filter((_, i) => i !== index);
    setIncomingTransfers(prev => prev.filter((_, i) => i !== index));
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
    totalBalance,
    mintBalances,
    unitBalances,
    proofCountByMint,
    mintFeePpk,
    keysetFeeMap,
    pendingProofCount,

    // Mint operations
    addMint,
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
    clearTransactionToken,
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
