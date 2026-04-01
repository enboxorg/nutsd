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
  // The mint URL is a UTF-8 string embedded in the CBOR payload.
  // Rather than adding a CBOR parser, we decode the bytes and
  // search for the URL pattern — the mint URL is the only URL present.
  if (trimmed.startsWith('cashuB')) {
    try {
      const b64url = trimmed.slice(6);
      // base64url → standard base64
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      const text = new TextDecoder().decode(bytes);
      const match = text.match(/https?:\/\/[^\x00-\x1f\x7f-\x9f\s"',}\]]+/);
      if (match) {
        // Clean trailing non-URL bytes that CBOR length encoding may leave
        return match[0].replace(/[^a-zA-Z0-9/:._~\-!$&'()*+,;=@%]+$/, '');
      }
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

/** Calculate total amount from a set of proofs. */
export function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

/** Check if a string looks like a Cashu token. */
export function isCashuToken(str: string): boolean {
  const trimmed = str.trim();
  return trimmed.startsWith('cashuA') || trimmed.startsWith('cashuB');
}
