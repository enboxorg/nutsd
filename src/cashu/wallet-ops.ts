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
  Wallet,
} from '@cashu/cashu-ts';

// Re-export for consumers that need the quote types
export type { MintQuoteBolt11Response, MeltQuoteBolt11Response, MintInfo };

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

/** Swap proofs for new proofs (e.g. to consolidate or split). */
export async function swapProofs(
  mintUrl: string,
  proofs: Proof[],
  amount: number,
  unit = 'sat',
): Promise<{ send: Proof[]; keep: Proof[] }> {
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.send(amount, proofs);
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
  } catch {
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

/** Fetch mint keysets. */
export async function getMintKeysets(mintUrl: string, unit = 'sat') {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.keyChain;
}
