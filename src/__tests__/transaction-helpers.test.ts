import { describe, it, expect } from 'vitest';
import { isUnfulfilledInvoice, isExpiredInvoice, decideMintSettlement, decideSweepAction } from '../lib/transaction-helpers';
import type { Transaction } from '../hooks/use-wallet';

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-1',
    type: 'mint',
    amount: 1000,
    unit: 'sat',
    mintUrl: 'https://mint.example',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isUnfulfilledInvoice', () => {
  it('returns true for pending mint with invoice', () => {
    expect(isUnfulfilledInvoice(makeTx({ status: 'pending', invoice: 'lnbc...' }))).toBe(true);
  });

  it('returns true for failed mint with invoice (post-restart expired)', () => {
    expect(isUnfulfilledInvoice(makeTx({ status: 'failed', invoice: 'lnbc...' }))).toBe(true);
  });

  it('returns false for completed mint', () => {
    expect(isUnfulfilledInvoice(makeTx({ status: 'completed', invoice: 'lnbc...' }))).toBe(false);
  });

  it('returns false for pending mint without invoice', () => {
    expect(isUnfulfilledInvoice(makeTx({ status: 'pending', invoice: undefined }))).toBe(false);
  });

  it('returns false for non-mint types', () => {
    expect(isUnfulfilledInvoice(makeTx({ type: 'send', status: 'pending', invoice: 'lnbc...' }))).toBe(false);
    expect(isUnfulfilledInvoice(makeTx({ type: 'receive', status: 'pending', invoice: 'lnbc...' }))).toBe(false);
  });
});

describe('isExpiredInvoice', () => {
  it('returns true for failed mint with invoice (recovery marked it failed)', () => {
    expect(isExpiredInvoice(makeTx({ status: 'failed', invoice: 'lnbc...' }))).toBe(true);
  });

  it('returns true for pending mint with past expiresAt', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isExpiredInvoice(makeTx({ status: 'pending', invoice: 'lnbc...', expiresAt: past }))).toBe(true);
  });

  it('returns false for pending mint with future expiresAt', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isExpiredInvoice(makeTx({ status: 'pending', invoice: 'lnbc...', expiresAt: future }))).toBe(false);
  });

  it('returns false for pending mint with no expiresAt', () => {
    expect(isExpiredInvoice(makeTx({ status: 'pending', invoice: 'lnbc...' }))).toBe(false);
  });

  it('returns false for completed mint', () => {
    expect(isExpiredInvoice(makeTx({ status: 'completed', invoice: 'lnbc...' }))).toBe(false);
  });

  it('returns false for non-mint types even if failed with invoice', () => {
    expect(isExpiredInvoice(makeTx({ type: 'send', status: 'failed', invoice: 'lnbc...' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideMintSettlement — dialog/sweep settlement decision
// ---------------------------------------------------------------------------

describe('decideMintSettlement', () => {
  it('returns complete with Lightning memo when fully persisted', () => {
    const action = decideMintSettlement(true, 'lightning');
    expect(action).toEqual({ type: 'complete', memo: 'Lightning receive' });
  });

  it('returns complete with LNURL memo when fully persisted', () => {
    const action = decideMintSettlement(true, 'lnurl-withdraw');
    expect(action).toEqual({ type: 'complete', memo: 'LNURL withdraw' });
  });

  it('includes LNURL description in memo when provided', () => {
    const action = decideMintSettlement(true, 'lnurl-withdraw', 'My Service');
    expect(action).toEqual({ type: 'complete', memo: 'LNURL withdraw: My Service' });
  });

  it('returns defer when not fully persisted (Lightning)', () => {
    const action = decideMintSettlement(false, 'lightning');
    expect(action.type).toBe('defer');
    expect((action as { type: 'defer'; reason: string }).reason).toContain('partial');
  });

  it('returns defer when not fully persisted (LNURL)', () => {
    const action = decideMintSettlement(false, 'lnurl-withdraw', 'Service');
    expect(action.type).toBe('defer');
  });
});

// ---------------------------------------------------------------------------
// decideSweepAction — background sweep quote-state decision
// ---------------------------------------------------------------------------

describe('decideSweepAction', () => {
  it('returns complete with stash recovery for ISSUED (Lightning)', () => {
    const action = decideSweepAction('ISSUED', 'lightning', null);
    expect(action).toEqual({
      type: 'complete',
      memo: 'Lightning receive (already minted)',
      needsStashRecovery: true,
    });
  });

  it('returns complete with stash recovery for ISSUED (LNURL)', () => {
    const action = decideSweepAction('ISSUED', 'lnurl-withdraw', null);
    expect(action).toEqual({
      type: 'complete',
      memo: 'LNURL withdraw (already minted)',
      needsStashRecovery: true,
    });
  });

  it('returns skip for PAID (caller handles settlement)', () => {
    expect(decideSweepAction('PAID', 'lightning', null)).toEqual({ type: 'skip' });
  });

  it('returns markFailed for UNPAID with past expiry', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 60;
    const action = decideSweepAction('UNPAID', 'lightning', pastExpiry);
    expect(action).toEqual({ type: 'markFailed', memo: 'Quote expired before payment' });
  });

  it('returns skip for UNPAID with future expiry', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    expect(decideSweepAction('UNPAID', 'lightning', futureExpiry)).toEqual({ type: 'skip' });
  });

  it('returns skip for UNPAID with no expiry', () => {
    expect(decideSweepAction('UNPAID', 'lightning', null)).toEqual({ type: 'skip' });
  });

  it('returns skip for unknown states', () => {
    expect(decideSweepAction('UNKNOWN', 'lightning', null)).toEqual({ type: 'skip' });
  });
});
