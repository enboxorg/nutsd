/**
 * Core Cashu wallet operations wrapping @cashu/cashu-ts.
 *
 * Provides mint/melt/swap/send/receive operations that interact
 * with Cashu mints via the cashu-ts Wallet class, while persisting
 * proof state through a DWN-backed proof store.
 *
 * @module
 */

import {
  type Proof,
  type MintQuoteBolt11Response,
  type MeltQuoteBolt11Response,
  type MintInfo,
  type MintKeys,
  Wallet,
} from '@cashu/cashu-ts';

// Re-export for consumers that need the quote types
export type { MintQuoteBolt11Response, MeltQuoteBolt11Response, MintInfo, MintKeys };

// ---------------------------------------------------------------------------
// Wallet instance cache — one Wallet per mint URL
// ---------------------------------------------------------------------------

const walletCache = new Map<string, Wallet>();

/**
 * Get or create a cashu-ts Wallet for a given mint URL.
 * Wallets are mostly stateless, so caching is safe.
 */
export async function getWallet(mintUrl: string, unit = 'sat'): Promise<Wallet> {
  const key = `${mintUrl}:${unit}`;
  let wallet = walletCache.get(key);
  if (!wallet) {
    wallet = new Wallet(mintUrl, { unit });
    await wallet.loadMint();
    walletCache.set(key, wallet);
  }
  return wallet;
}

/** Clear the wallet cache (e.g. on disconnect). */
export function clearWalletCache(): void {
  walletCache.clear();
}

/** Evict a specific mint from the wallet cache (e.g. on keyset rotation). */
export function evictWalletCache(mintUrl: string, unit?: string): void {
  if (unit) {
    walletCache.delete(`${mintUrl}:${unit}`);
  } else {
    // Evict all units for this URL
    for (const key of walletCache.keys()) {
      if (key.startsWith(`${mintUrl}:`)) {
        walletCache.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mint tokens (deposit via Lightning)
// ---------------------------------------------------------------------------

/** Request a mint quote (Lightning invoice to pay). */
export async function createMintQuote(
  mintUrl: string,
  amount: number,
  unit = 'sat',
): Promise<MintQuoteBolt11Response> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.createMintQuoteBolt11(amount);
}

/** Check the status of a mint quote. */
export async function checkMintQuote(
  mintUrl: string,
  quoteId: string,
  unit = 'sat',
): Promise<MintQuoteBolt11Response> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.checkMintQuoteBolt11(quoteId);
}

/** Mint tokens after the Lightning invoice has been paid. Returns new proofs. */
export async function mintTokens(
  mintUrl: string,
  amount: number,
  quoteId: string,
  unit = 'sat',
): Promise<Proof[]> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.mintProofsBolt11(amount, quoteId);
}

// ---------------------------------------------------------------------------
// Melt tokens (withdraw via Lightning)
// ---------------------------------------------------------------------------

/** Request a melt quote (how much ecash to burn for a Lightning payment). */
export async function createMeltQuote(
  mintUrl: string,
  invoice: string,
  unit = 'sat',
): Promise<MeltQuoteBolt11Response> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.createMeltQuoteBolt11(invoice);
}

/**
 * Check the state of a melt quote (NUT-05).
 *
 * Used after a melt failure to determine whether the Lightning payment
 * actually went through. If UNPAID, proofs can be safely reverted.
 */
export async function checkMeltQuote(
  mintUrl: string,
  quoteId: string,
  unit = 'sat',
): Promise<{ state: string; paid: boolean }> {
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.checkMeltQuoteBolt11(quoteId) as any;
  const state = result.state ?? (result.paid ? 'PAID' : 'UNPAID');
  return { state, paid: state === 'PAID' };
}

/** Melt proofs to pay a Lightning invoice. Returns change proofs (if any). */
export async function meltTokens(
  mintUrl: string,
  meltQuote: MeltQuoteBolt11Response,
  proofs: Proof[],
  unit = 'sat',
): Promise<{ paid: boolean; change: Proof[] }> {
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.meltProofsBolt11(meltQuote, proofs);
  return {
    paid: result.quote.state === 'PAID',
    change: result.change,
  };
}

// ---------------------------------------------------------------------------
// Swap tokens
// ---------------------------------------------------------------------------

/**
 * Swap proofs for new proofs (e.g. to consolidate or split).
 *
 * When `includeFees` is true, the send amount accounts for NUT-02 input fees.
 * cashu-ts handles the fee calculation internally — the returned `send` proofs
 * will total exactly `amount` and the fee is deducted from `keep`.
 */
export async function swapProofs(
  mintUrl: string,
  proofs: Proof[],
  amount: number,
  unit = 'sat',
  options?: { includeFees?: boolean },
): Promise<{ send: Proof[]; keep: Proof[] }> {
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.send(amount, proofs, {
    includeFees: options?.includeFees ?? true,
  });
  return {
    send: result.send,
    keep: result.keep,
  };
}

// ---------------------------------------------------------------------------
// Receive tokens
// ---------------------------------------------------------------------------

/** Receive (claim) a Cashu token by swapping with the mint. Returns new proofs. */
export async function receiveToken(
  mintUrl: string,
  encodedToken: string,
  unit = 'sat',
): Promise<Proof[]> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.receive(encodedToken);
}

// ---------------------------------------------------------------------------
// Check proof state
// ---------------------------------------------------------------------------

export type ProofStateResult = {
  Y: string;
  state: 'UNSPENT' | 'PENDING' | 'SPENT';
  witness: string | null;
};

/** Check the state of proofs with the mint (NUT-07). */
export async function checkProofsState(
  mintUrl: string,
  proofs: Proof[],
  unit = 'sat',
): Promise<ProofStateResult[]> {
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.checkProofsStates(proofs);
  return result as ProofStateResult[];
}

/**
 * Group proofs by their mint-side state using NUT-07.
 *
 * Uses Y-value (public point of each secret) for matching, which is
 * robust against response ordering differences. Preferred over
 * checkProofsState + index-based matching.
 */
export async function groupProofsByState(
  mintUrl: string,
  proofs: Proof[],
  unit = 'sat',
): Promise<{ unspent: Proof[]; pending: Proof[]; spent: Proof[] }> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.groupProofsByState(proofs);
}

/**
 * Check whether a sent Cashu token has been spent (claimed by recipient).
 *
 * Decodes the token, checks each proof's state with the mint (NUT-07).
 * Returns true if ALL proofs are SPENT, false if any are UNSPENT/PENDING,
 * or null if the check could not be performed.
 */
export async function checkTokenSpent(
  encodedToken: string,
  mintUrl: string,
  unit = 'sat',
): Promise<boolean | null> {
  try {
    const wallet = await getWallet(mintUrl, unit);
    // Decode using the wallet's keysets (handles V4 short IDs)
    const token = wallet.decodeToken(encodedToken);
    const states = await wallet.checkProofsStates(token.proofs);
    // All proofs spent = token fully claimed
    return states.every((s) => s.state === 'SPENT');
  } catch (err) {
    console.warn('[nutsd:financial] checkTokenSpent failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mint info
// ---------------------------------------------------------------------------

/** Fetch mint info (NUT-06). Returns a MintInfo class instance. */
export async function getMintInfo(mintUrl: string, unit = 'sat'): Promise<MintInfo> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.getMintInfo();
}

/** Fetch mint keysets (the full key chain). */
export async function getMintKeysets(mintUrl: string, unit = 'sat') {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.keyChain;
}

/**
 * Check whether a Cashu token is still spendable (all proofs UNSPENT).
 *
 * Used as a pre-check before attempting to receive/claim a token.
 * If the token is already spent or pending, the receive will fail at the
 * mint — this check avoids that confusing error.
 *
 * Returns true if all proofs are UNSPENT, false otherwise, null on error.
 */
export async function isTokenSpendable(
  encodedToken: string,
  mintUrl: string,
  unit = 'sat',
): Promise<boolean | null> {
  try {
    const wallet = await getWallet(mintUrl, unit);
    const token = wallet.decodeToken(encodedToken);
    const states = await wallet.checkProofsStates(token.proofs);
    return states.every((s) => s.state === 'UNSPENT');
  } catch (err) {
    console.warn('[nutsd:financial] isTokenSpendable check failed:', err);
    return null; // can't determine — proceed with receive attempt
  }
}

// ---------------------------------------------------------------------------
// Keyset info (NUT-02 fees)
// ---------------------------------------------------------------------------

/** Metadata for a single keyset, including NUT-02 input fee rate. */
export type KeysetInfo = {
  /** Keyset ID (hex string). */
  id: string;
  /** Currency unit. */
  unit: string;
  /** Whether this keyset is currently active at the mint. */
  active: boolean;
  /** Input fee rate in parts per thousand (NUT-02). 0 means no fee. */
  inputFeePpk: number;
};

/**
 * Fetch active keyset info from a mint, including NUT-02 input fees.
 *
 * Loads the mint's keysets and extracts metadata (id, unit, active, inputFeePpk)
 * for each one. This is the source of truth for fee rates.
 */
export async function getKeysetInfos(mintUrl: string, unit = 'sat'): Promise<KeysetInfo[]> {
  const wallet = await getWallet(mintUrl, unit);
  const keysets: KeysetInfo[] = [];

  for (const [id, keys] of Object.entries(wallet.keyChain)) {
    const mintKeys = keys as MintKeys;
    keysets.push({
      id,
      unit    : mintKeys.unit ?? unit,
      active  : mintKeys.active !== false,
      // inputFeePpk comes from the keyset info; default 0 if absent
      inputFeePpk : mintKeys.input_fee_ppk ?? 0,
    });
  }

  return keysets;
}

// ---------------------------------------------------------------------------
// Fee calculation (NUT-02)
// ---------------------------------------------------------------------------

/**
 * Calculate the input fee for a given number of proofs.
 *
 * NUT-02 formula: `fee = max(0, ceil(numInputs * feePpk / 1000))`
 *
 * @param numInputs - Number of proof inputs being submitted
 * @param feePpk - Input fee rate in parts per thousand (from keyset info)
 * @returns Fee amount in the mint's unit
 */
export function calculateInputFee(numInputs: number, feePpk: number): number {
  if (feePpk <= 0 || numInputs <= 0) return 0;
  return Math.max(0, Math.ceil(numInputs * feePpk / 1000));
}

/**
 * Estimate the total input fee for a set of proofs at a given mint.
 *
 * Groups proofs by keyset ID and applies each keyset's fee rate separately,
 * then sums the per-keyset fees.
 *
 * @param proofs - Proofs to estimate fees for
 * @param keysetFees - Map of keyset ID -> inputFeePpk
 * @returns Total estimated input fee
 */
export function estimateInputFee(
  proofs: Proof[],
  keysetFees: Map<string, number>,
): number {
  // Group proof count by keyset
  const countByKeyset = new Map<string, number>();
  for (const proof of proofs) {
    countByKeyset.set(proof.id, (countByKeyset.get(proof.id) ?? 0) + 1);
  }

  let totalFee = 0;
  for (const [keysetId, count] of countByKeyset) {
    const feePpk = keysetFees.get(keysetId) ?? 0;
    totalFee += calculateInputFee(count, feePpk);
  }
  return totalFee;
}
