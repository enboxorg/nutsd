/**
 * Top-level wallet hook.
 *
 * Initializes the DWN repository for the Cashu Wallet protocol,
 * sets up subscriptions for real-time sync, and provides the
 * repository to child hooks.
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
  type TransactionData,
  type PreferenceData,
  type ProofState,
  type KeysetData,
} from '@/protocol/cashu-wallet-protocol';

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

export interface Transaction {
  id: string;
  type: TransactionData['type'];
  amount: number;
  unit: string;
  mintUrl: string;
  status: TransactionData['status'];
  cashuToken?: string;
  lightningInvoice?: string;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;

export function useWallet() {
  const { enbox, isConnected } = useEnbox();

  const [repo, setRepo] = useState<Repo>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedRef = useRef<any>(null);

  // --- Core state ---
  const [mints, setMints] = useState<Mint[]>([]);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [preferences, setPreferences] = useState<WalletPreferences>({});
  const [loading, setLoading] = useState(false);

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
    } else {
      typedRef.current = null;
      setRepo(null);
      setMints([]);
      setProofs([]);
      setTransactions([]);
      setPreferences({});
    }
  }, [enbox, isConnected]);

  // --- Refresh functions ---

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

  const refreshProofs = useCallback(async () => {
    if (!repo || mints.length === 0) {
      setProofs([]);
      return;
    }
    try {
      const allProofs: StoredProof[] = [];
      for (const mint of mints) {
        const { records } = await repo.mint.proof.query(mint.contextId);
        for (const r of records) {
          const data: ProofData = await r.data.json();
          allProofs.push({
            id             : r.id,
            contextId      : r.contextId ?? r.id,
            mintContextId  : mint.contextId,
            mintUrl        : mint.url,
            amount         : data.amount,
            keysetId       : data.id,
            secret         : data.secret,
            C              : data.C,
            state          : (r.tags?.state as ProofState) ?? 'unspent',
            dleq           : data.dleq,
            witness        : data.witness,
          });
        }
      }
      setProofs(allProofs);
    } catch (err) {
      console.error('Failed to load proofs:', err);
    }
  }, [repo, mints]);

  const refreshTransactions = useCallback(async () => {
    if (!repo) return;
    try {
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
          lightningInvoice : data.lightningInvoice,
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

  // --- Initial load ---
  useEffect(() => {
    if (!repo) return;
    setLoading(true);
    Promise.all([refreshMints(), refreshTransactions(), refreshPreferences()])
      .finally(() => setLoading(false));
  }, [repo, refreshMints, refreshTransactions, refreshPreferences]);

  // Proofs depend on mints being loaded
  useEffect(() => {
    if (mints.length > 0) refreshProofs();
  }, [mints, refreshProofs]);

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
      refreshTransactions();
      refreshPreferences();
    };
  }, [refreshMints, refreshProofs, refreshTransactions, refreshPreferences]);

  // --- Computed values ---

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

  // --- Mint CRUD ---

  const addMint = useCallback(async (data: MintData): Promise<Mint | undefined> => {
    if (!repo) return;
    const { record } = await repo.mint.create({
      data,
      tags: { url: data.url, unit: data.unit, active: data.active },
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
    return mint;
  }, [repo]);

  const removeMint = useCallback(async (id: string) => {
    if (!repo) return;
    await repo.mint.delete(id);
    setMints(prev => prev.filter(m => m.id !== id));
  }, [repo]);

  // --- Proof CRUD ---

  const addProof = useCallback(async (
    mintContextId: string,
    proofData: ProofData,
    state: ProofState = 'unspent',
  ): Promise<StoredProof | undefined> => {
    if (!repo) return;
    const mint = mints.find(m => m.contextId === mintContextId);
    const { record } = await repo.mint.proof.create(mintContextId, {
      data: proofData,
      tags: { amount: proofData.amount, keysetId: proofData.id, state },
    });
    if (!record) throw new Error('Failed to store proof');
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
    setProofs(prev => prev.filter(p => p.id !== id));
  }, [repo]);

  /** Delete multiple proofs by their DWN record IDs. */
  const deleteProofs = useCallback(async (ids: string[]) => {
    for (const id of ids) {
      await deleteProof(id);
    }
  }, [deleteProof]);

  // --- Keyset CRUD ---

  const addKeyset = useCallback(async (mintContextId: string, data: KeysetData) => {
    if (!repo) return;
    await repo.mint.keyset.create(mintContextId, {
      data,
      tags: { keysetId: data.keysetId, active: data.active },
    });
  }, [repo]);

  // --- Transaction CRUD ---

  const addTransaction = useCallback(async (data: TransactionData): Promise<Transaction | undefined> => {
    if (!repo) return;
    const { record } = await repo.transaction.create({
      data,
      tags: { type: data.type, mintUrl: data.mintUrl, status: data.status },
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
      lightningInvoice : data.lightningInvoice,
      recipientDid     : data.recipientDid,
      senderDid        : data.senderDid,
      memo             : data.memo,
      createdAt        : data.createdAt,
    };
    setTransactions(prev => [tx, ...prev]);
    return tx;
  }, [repo]);

  // --- Preferences ---

  const updatePreferences = useCallback(async (data: PreferenceData) => {
    if (!repo) return;
    await repo.preference.set({ data });
    setPreferences(data);
  }, [repo]);

  // --- Unspent proofs for a specific mint ---

  const getUnspentProofsForMint = useCallback((mintUrl: string): StoredProof[] => {
    return proofs.filter(p => p.state === 'unspent' && p.mintUrl === mintUrl);
  }, [proofs]);

  return {
    // State
    mints,
    proofs,
    transactions,
    preferences,
    loading,
    totalBalance,
    mintBalances,

    // Mint operations
    addMint,
    removeMint,
    refreshMints,

    // Proof operations
    addProof,
    addProofs,
    deleteProof,
    deleteProofs,
    refreshProofs,
    getUnspentProofsForMint,

    // Transaction operations
    addTransaction,
    refreshTransactions,

    // Preferences
    updatePreferences,

    // Keyset
    addKeyset,

    // Repo access for advanced operations
    repo,
  };
}
