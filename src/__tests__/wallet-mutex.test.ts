import { describe, it, expect, beforeEach } from 'vitest';
import { acquireWalletLock, tryAcquireWalletLock, isWalletLocked, getWalletLockHolder, _resetMutex } from '../lib/wallet-mutex';

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

  describe('tryAcquireWalletLock', () => {
    it('acquires lock when free', () => {
      const release = tryAcquireWalletLock('try-op');
      expect(release).not.toBeNull();
      expect(isWalletLocked()).toBe(true);
      expect(getWalletLockHolder()).toBe('try-op');
      release!();
      expect(isWalletLocked()).toBe(false);
    });

    it('returns null when lock is held', async () => {
      const release = await acquireWalletLock('blocker');
      const result = tryAcquireWalletLock('try-op');
      expect(result).toBeNull();
      expect(getWalletLockHolder()).toBe('blocker');
      release();
    });

    it('does not jump the wait queue', async () => {
      const release1 = await acquireWalletLock('op1');

      // Queue a waiter
      const p2 = acquireWalletLock('op2', 5000);

      // tryAcquire should fail — lock held by op1
      expect(tryAcquireWalletLock('try-op')).toBeNull();

      // Release op1 — op2 should get the lock, not a future tryAcquire
      release1();
      const release2 = await p2;
      expect(getWalletLockHolder()).toBe('op2');

      // tryAcquire should still fail — lock held by op2
      expect(tryAcquireWalletLock('try-op')).toBeNull();

      release2();
    });
  });
});
