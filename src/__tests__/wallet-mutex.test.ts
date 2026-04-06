import { describe, it, expect, beforeEach } from 'vitest';
import { acquireWalletLock, isWalletLocked, getWalletLockHolder, _resetMutex } from '../lib/wallet-mutex';

describe('wallet-mutex', () => {
  beforeEach(() => {
    _resetMutex();
  });
  it('acquires and releases lock', async () => {
    const release = await acquireWalletLock('test-op');
    expect(isWalletLocked()).toBe(true);
    expect(getWalletLockHolder()).toBe('test-op');

    release();
    expect(isWalletLocked()).toBe(false);
    expect(getWalletLockHolder()).toBe(null);
  });

  it('prevents double acquisition', async () => {
    const release1 = await acquireWalletLock('op1');

    // Second acquire should wait, then timeout
    await expect(acquireWalletLock('op2', 100)).rejects.toThrow('Wallet lock timeout');

    release1();
  });

  it('queues waiters and releases in order', async () => {
    const order: string[] = [];
    const release1 = await acquireWalletLock('op1');

    // Queue two waiters
    const p2 = acquireWalletLock('op2', 5000).then(release => {
      order.push('op2');
      release();
    });
    const p3 = acquireWalletLock('op3', 5000).then(release => {
      order.push('op3');
      release();
    });

    // Release op1 — should wake op2, then op3
    release1();
    await p2;
    await p3;

    expect(order).toEqual(['op2', 'op3']);
  });

  it('release is idempotent', async () => {
    const release = await acquireWalletLock('test');
    release();
    release(); // should not throw
    expect(isWalletLocked()).toBe(false);
  });

  it('returns lock holder name', async () => {
    expect(getWalletLockHolder()).toBe(null);
    const release = await acquireWalletLock('melt-operation');
    expect(getWalletLockHolder()).toBe('melt-operation');
    release();
    expect(getWalletLockHolder()).toBe(null);
  });
});
