/**
 * Token serialization and utility functions.
 *
 * Handles parsing Cashu tokens, extracting metadata,
 * and proof selection for spending.
 *
 * @module
 */

import { type Proof, type Token, getDecodedToken, getEncodedTokenV4 } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

export interface ParsedToken {
  /** Mint URL from the token. */
  mintUrl: string;
  /** Proofs contained in the token. */
  proofs: Proof[];
  /** Total amount of all proofs. */
  amount: number;
  /** Currency unit. */
  unit?: string;
  /** Optional memo. */
  memo?: string;
}

/**
 * Parse a serialized Cashu token (V3 or V4).
 *
 * For V4 tokens, keyset IDs must be provided to map short IDs.
 * Use `extractMintUrl` + `wallet.receive()` for receiving tokens
 * from unknown mints.
 */
export function parseToken(encodedToken: string, keysetIds?: string[]): ParsedToken {
  const decoded: Token = getDecodedToken(encodedToken, keysetIds);

  const amount = decoded.proofs.reduce((sum, p) => sum + p.amount, 0);

  return {
    mintUrl : decoded.mint,
    proofs  : decoded.proofs,
    amount,
    unit    : decoded.unit,
    memo    : decoded.memo,
  };
}

/**
 * Extract the mint URL from a Cashu token without full proof decoding.
 *
 * This avoids the V4 short-keyset-ID mapping problem, which requires
 * a wallet loaded with the mint's keysets. Safe to call before a
 * wallet exists for this mint.
 */
export function extractMintUrl(encodedToken: string): string | null {
  const trimmed = encodedToken.trim();

  // V3 token (cashuA): base64-encoded JSON
  if (trimmed.startsWith('cashuA')) {
    try {
      const json = JSON.parse(atob(trimmed.slice(6)));
      // V3 format: { token: [{ mint: "...", proofs: [...] }] }
      if (json.token?.[0]?.mint) return json.token[0].mint;
    } catch { /* fall through */ }
  }

  // V4 token (cashuB): base64url-encoded CBOR
  // Minimal CBOR parsing to extract the "m" (mint URL) field.
  // CBOR fields are length-prefixed, so we read the exact byte length
  // of the URL string rather than using regex (which grabs adjacent fields).
  if (trimmed.startsWith('cashuB')) {
    try {
      const b64url = trimmed.slice(6);
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      const url = readCborMintUrl(bytes);
      if (url) return url;
    } catch { /* fall through */ }
  }

  return null;
}

/** Encode proofs as a V4 token string. */
export function encodeToken(
  mintUrl: string,
  proofs: Proof[],
  unit = 'sat',
  memo?: string,
): string {
  const token: Token = {
    mint: mintUrl,
    proofs,
    unit,
    memo,
  };
  return getEncodedTokenV4(token);
}

// ---------------------------------------------------------------------------
// Proof selection
// ---------------------------------------------------------------------------

/**
 * Select the optimal subset of proofs to meet a target amount.
 *
 * Strategy:
 * 1. Try to find an exact match
 * 2. Otherwise, find the smallest set of proofs >= target
 * 3. Minimize change (overpayment)
 */
export function selectProofs(
  proofs: Proof[],
  targetAmount: number,
): { selected: Proof[]; remaining: Proof[]; change: number } {
  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);

  const total = sorted.reduce((sum, p) => sum + p.amount, 0);
  if (total < targetAmount) {
    throw new Error(`Insufficient balance: have ${total}, need ${targetAmount}`);
  }

  if (total === targetAmount) {
    return { selected: sorted, remaining: [], change: 0 };
  }

  const selected: Proof[] = [];
  let selectedSum = 0;

  for (const proof of sorted) {
    if (selectedSum >= targetAmount) break;
    selected.push(proof);
    selectedSum += proof.amount;
  }

  const remaining = sorted.filter(p => !selected.includes(p));
  const change = selectedSum - targetAmount;

  return { selected, remaining, change };
}

/**
 * Select proofs accounting for NUT-02 input fees.
 *
 * The total cost is `targetAmount + inputFee`, but the input fee depends on
 * how many proofs are selected — creating a circular dependency. This function
 * iterates until the selection stabilizes (usually 1-2 rounds).
 *
 * @param proofs - Available proofs (unspent)
 * @param targetAmount - Desired send/melt amount (excluding fees)
 * @param feePpk - Input fee rate in parts per thousand (NUT-02)
 * @returns Selected proofs, remaining proofs, change amount, and computed fee
 */
export function selectProofsWithFees(
  proofs: Proof[],
  targetAmount: number,
  feePpk: number,
): { selected: Proof[]; remaining: Proof[]; change: number; fee: number } {
  if (feePpk <= 0) {
    const result = selectProofs(proofs, targetAmount);
    return { ...result, fee: 0 };
  }

  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((sum, p) => sum + p.amount, 0);

  // Iterative: select, compute fee, check if we have enough, re-select
  let currentTarget = targetAmount;
  let fee = 0;
  let result: ReturnType<typeof selectProofs>;

  for (let i = 0; i < 10; i++) { // max 10 iterations (safety bound)
    if (total < currentTarget) {
      throw new Error(`Insufficient balance: have ${total}, need ${currentTarget} (including ${fee} fee)`);
    }
    result = selectProofs(sorted, currentTarget);
    fee = Math.max(0, Math.ceil(result.selected.length * feePpk / 1000));
    const neededTotal = targetAmount + fee;

    if (sumProofs(result.selected) >= neededTotal) {
      // We have enough including fees
      return {
        selected  : result.selected,
        remaining : result.remaining,
        change    : sumProofs(result.selected) - neededTotal,
        fee,
      };
    }
    // Need more — increase target and re-select
    currentTarget = neededTotal;
  }

  // Should not reach here, but satisfy TypeScript
  throw new Error(`Fee calculation did not converge for amount ${targetAmount} with feePpk ${feePpk}`);
}

/** Calculate total amount from a set of proofs. */
export function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

/** Check if a string looks like a Cashu token. */
export function isCashuToken(str: string): boolean {
  const trimmed = str.trim();
  return trimmed.startsWith('cashuA') || trimmed.startsWith('cashuB');
}

// ---------------------------------------------------------------------------
// Minimal CBOR parsing for V4 token mint URL extraction
// ---------------------------------------------------------------------------

/**
 * Read a CBOR text string at a given offset.
 * Returns the decoded string and the byte offset after it, or null on failure.
 *
 * CBOR text strings (major type 3):
 *   0x60-0x77 : inline length 0-23
 *   0x78      : 1-byte length follows
 *   0x79      : 2-byte length follows
 */
function readCborText(bytes: Uint8Array, offset: number): { value: string; end: number } | null {
  if (offset >= bytes.length) return null;
  const initial = bytes[offset];
  const majorType = initial >> 5;
  if (majorType !== 3) return null; // not a text string

  const info = initial & 0x1f;
  let length: number;
  let dataStart: number;

  if (info < 24) {
    length = info;
    dataStart = offset + 1;
  } else if (info === 24) {
    if (offset + 1 >= bytes.length) return null;
    length = bytes[offset + 1];
    dataStart = offset + 2;
  } else if (info === 25) {
    if (offset + 2 >= bytes.length) return null;
    length = (bytes[offset + 1] << 8) | bytes[offset + 2];
    dataStart = offset + 3;
  } else {
    return null; // 4-byte / 8-byte / indefinite — too long for a mint URL
  }

  if (dataStart + length > bytes.length) return null;
  const value = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + length));
  return { value, end: dataStart + length };
}

/**
 * Extract the mint URL from V4 token CBOR bytes.
 *
 * The V4 token is a CBOR map with key "m" → mint URL string.
 * We scan for the CBOR encoding of the key "m" (0x61 0x6d = text(1) "m")
 * and then read the following CBOR text string with its exact length prefix.
 */
function readCborMintUrl(bytes: Uint8Array): string | null {
  // Search for key "m": CBOR text string of length 1 containing 'm'
  // Encoded as: 0x61 (major type 3, length 1) followed by 0x6d ('m')
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x61 && bytes[i + 1] === 0x6d) {
      // The value immediately follows the key
      const result = readCborText(bytes, i + 2);
      if (result && result.value.startsWith('http')) {
        return result.value;
      }
    }
  }
  return null;
}
