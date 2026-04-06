import { describe, it, expect } from 'vitest';
import type { PaymentRequest } from '../cashu/payment-request';

/**
 * Tests for payment request mint matching logic.
 *
 * These validate the matching rules used by PayRequestDialog and
 * CreateRequestDialog to ensure multi-unit mints are handled correctly.
 */

// Simplified Mint type matching the hook's Mint interface
type Mint = { url: string; unit: string; name?: string; contextId: string };

const MINTS: Mint[] = [
  { url: 'https://mint.example.com', unit: 'sat', contextId: 'ctx-sat' },
  { url: 'https://mint.example.com', unit: 'usd', contextId: 'ctx-usd' },
  { url: 'https://other-mint.com',   unit: 'sat', contextId: 'ctx-other' },
];

/**
 * Reproduces the PayRequestDialog matching logic:
 * - If request specifies mints: match by URL + unit. No fallback.
 * - If no mint restriction: match by unit only.
 * - Never fall back to a mint with the wrong unit.
 */
function matchMintForRequest(
  mints: Mint[],
  request: PaymentRequest,
): Mint | undefined {
  const requestUnit = request.unit ?? 'sat';
  return request.mints?.length
    ? mints.find(m => request.mints!.includes(m.url) && m.unit === requestUnit)
    : mints.find(m => m.unit === requestUnit);
}

/**
 * Reproduces the CreateRequestDialog mint key:
 * uses URL + unit as composite key so multi-unit mints are distinguishable.
 */
function mintKey(mint: Mint): string {
  return `${mint.url}|${mint.unit}`;
}

describe('PayRequestDialog mint matching', () => {
  it('matches by URL + unit when request specifies mints', () => {
    const request: PaymentRequest = {
      amount: 100,
      unit: 'usd',
      mints: ['https://mint.example.com'],
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.contextId).toBe('ctx-usd');
    expect(match?.unit).toBe('usd');
  });

  it('matches sat unit at the same URL', () => {
    const request: PaymentRequest = {
      amount: 100,
      unit: 'sat',
      mints: ['https://mint.example.com'],
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.contextId).toBe('ctx-sat');
  });

  it('returns undefined when URL matches but unit does not', () => {
    const request: PaymentRequest = {
      amount: 100,
      unit: 'eur',
      mints: ['https://mint.example.com'],
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match).toBeUndefined();
  });

  it('returns undefined when URL does not match', () => {
    const request: PaymentRequest = {
      amount: 100,
      unit: 'sat',
      mints: ['https://unknown-mint.com'],
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match).toBeUndefined();
  });

  it('matches by unit only when no mints specified in request', () => {
    const request: PaymentRequest = {
      amount: 50,
      unit: 'usd',
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.contextId).toBe('ctx-usd');
  });

  it('returns undefined when unit not available and no mints specified', () => {
    const request: PaymentRequest = {
      amount: 50,
      unit: 'eur',
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match).toBeUndefined();
  });

  it('defaults to sat when request has no unit', () => {
    const request: PaymentRequest = {
      amount: 100,
      mints: ['https://mint.example.com'],
    };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.unit).toBe('sat');
  });

  it('does NOT fall back to wrong unit when URL matches', () => {
    // Only EUR mint at this URL — request wants SAT
    const singleMint: Mint[] = [
      { url: 'https://eur-only.com', unit: 'eur', contextId: 'ctx-eur' },
    ];
    const request: PaymentRequest = {
      amount: 100,
      unit: 'sat',
      mints: ['https://eur-only.com'],
    };
    const match = matchMintForRequest(singleMint, request);
    expect(match).toBeUndefined();
  });
});

describe('Context-aware balance and proof selectors', () => {
  /**
   * Simulates the hook's mintBalancesByContext and getUnspentProofsByContext.
   * This is the REAL data flow the PayRequestDialog uses — keyed by contextId,
   * not URL. A URL-keyed selector would combine proofs from different units.
   */
  type StoredProof = { mintContextId: string; mintUrl: string; amount: number; state: string };

  const PROOFS: StoredProof[] = [
    { mintContextId: 'ctx-sat', mintUrl: 'https://mint.example.com', amount: 100, state: 'unspent' },
    { mintContextId: 'ctx-sat', mintUrl: 'https://mint.example.com', amount: 50,  state: 'unspent' },
    { mintContextId: 'ctx-usd', mintUrl: 'https://mint.example.com', amount: 10,  state: 'unspent' },
    { mintContextId: 'ctx-usd', mintUrl: 'https://mint.example.com', amount: 5,   state: 'unspent' },
  ];

  function getBalanceByContext(contextId: string): number {
    return PROOFS
      .filter(p => p.state === 'unspent' && p.mintContextId === contextId)
      .reduce((s, p) => s + p.amount, 0);
  }

  function getProofsByContext(contextId: string): StoredProof[] {
    return PROOFS.filter(p => p.state === 'unspent' && p.mintContextId === contextId);
  }

  // For comparison: what a URL-keyed selector would (incorrectly) return
  function getBalanceByUrl(url: string): number {
    return PROOFS
      .filter(p => p.state === 'unspent' && p.mintUrl === url)
      .reduce((s, p) => s + p.amount, 0);
  }

  it('context-keyed balance returns only the correct unit (sat)', () => {
    expect(getBalanceByContext('ctx-sat')).toBe(150);
  });

  it('context-keyed balance returns only the correct unit (usd)', () => {
    expect(getBalanceByContext('ctx-usd')).toBe(15);
  });

  it('URL-keyed balance incorrectly combines both units', () => {
    // This is the bug: URL-keyed returns sat + usd = 165
    expect(getBalanceByUrl('https://mint.example.com')).toBe(165);
    // Context-keyed returns the correct per-unit values
    expect(getBalanceByContext('ctx-sat')).not.toBe(getBalanceByUrl('https://mint.example.com'));
  });

  it('context-keyed proofs returns only the correct unit', () => {
    const satProofs = getProofsByContext('ctx-sat');
    expect(satProofs).toHaveLength(2);
    expect(satProofs.every(p => p.mintContextId === 'ctx-sat')).toBe(true);

    const usdProofs = getProofsByContext('ctx-usd');
    expect(usdProofs).toHaveLength(2);
    expect(usdProofs.every(p => p.mintContextId === 'ctx-usd')).toBe(true);
  });

  it('end-to-end: payment request for USD gets USD proofs, not SAT', () => {
    // 1. Match mint by URL + unit
    const request: PaymentRequest = { amount: 10, unit: 'usd', mints: ['https://mint.example.com'] };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.contextId).toBe('ctx-usd');
    expect(match?.unit).toBe('usd');

    // 2. Get balance and proofs by CONTEXT (not URL)
    const balance = getBalanceByContext(match!.contextId);
    expect(balance).toBe(15); // NOT 165

    const proofs = getProofsByContext(match!.contextId);
    expect(proofs).toHaveLength(2);
    expect(proofs.every(p => p.mintContextId === 'ctx-usd')).toBe(true);
  });

  it('end-to-end: payment request for SAT gets SAT proofs, not USD', () => {
    const request: PaymentRequest = { amount: 100, unit: 'sat', mints: ['https://mint.example.com'] };
    const match = matchMintForRequest(MINTS, request);
    expect(match?.contextId).toBe('ctx-sat');

    const balance = getBalanceByContext(match!.contextId);
    expect(balance).toBe(150);

    const proofs = getProofsByContext(match!.contextId);
    expect(proofs.every(p => p.mintContextId === 'ctx-sat')).toBe(true);
  });
});

describe('CreateRequestDialog mint key uniqueness', () => {
  it('generates unique keys for same URL with different units', () => {
    const satMint = MINTS[0];
    const usdMint = MINTS[1];
    expect(mintKey(satMint)).toBe('https://mint.example.com|sat');
    expect(mintKey(usdMint)).toBe('https://mint.example.com|usd');
    expect(mintKey(satMint)).not.toBe(mintKey(usdMint));
  });

  it('generates unique keys for different URLs with same unit', () => {
    const mint1 = MINTS[0];
    const mint2 = MINTS[2];
    expect(mintKey(mint1)).not.toBe(mintKey(mint2));
  });

  it('all mints in the test set have unique keys', () => {
    const keys = MINTS.map(mintKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
