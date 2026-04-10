import { describe, it, expect } from 'vitest';
import { isUnfulfilledInvoice, isExpiredInvoice } from '../lib/transaction-helpers';
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
