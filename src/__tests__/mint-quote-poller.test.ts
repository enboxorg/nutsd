import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMintQuotePolling } from '../lib/mint-quote-poller';

describe('startMintQuotePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onPaid only once when a quote stays PAID', async () => {
    const onPaid = vi.fn(async () => {});
    const resolveChecks: Array<(value: { state: 'PAID'; expiry: number | null }) => void> = [];
    const check = vi.fn(
      () => new Promise<{ state: 'PAID'; expiry: number | null }>((resolve) => {
        resolveChecks.push(resolve);
      }),
    );

    const stop = startMintQuotePolling({
      check,
      onPaid,
      intervalMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    // No overlap: second tick should not start a second in-flight check
    expect(check).toHaveBeenCalledTimes(1);

    resolveChecks[0]!({ state: 'PAID', expiry: null });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(6000);

    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it('expires unpaid quotes once expiry passes', async () => {
    const onExpired = vi.fn();
    const check = vi.fn(async () => ({ state: 'UNPAID' as const, expiry: 1 }));

    vi.setSystemTime(new Date(2000));
    startMintQuotePolling({
      check,
      onPaid: vi.fn(),
      onExpired,
      intervalMs: 3000,
      expiry: 1,
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('stops polling when disposed', async () => {
    const check = vi.fn(async () => ({ state: 'UNPAID' as const, expiry: null }));

    const stop = startMintQuotePolling({
      check,
      onPaid: vi.fn(),
      intervalMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(9000);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('calls onIssued for already-issued quotes', async () => {
    const onIssued = vi.fn();
    const check = vi.fn(async () => ({ state: 'ISSUED' as const, expiry: null }));

    startMintQuotePolling({
      check,
      onPaid: vi.fn(),
      onIssued,
      intervalMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(onIssued).toHaveBeenCalledTimes(1);
  });

  it('continues polling on transient check errors', async () => {
    let callCount = 0;
    const check = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
      return { state: 'UNPAID' as const, expiry: null };
    });

    const stop = startMintQuotePolling({
      check,
      onPaid: vi.fn(),
      intervalMs: 3000,
    });

    // First call: throws
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(1);

    // Second call: succeeds with UNPAID, keeps polling
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(2);

    stop();
  });

  it('respects isActive callback', async () => {
    let active = true;
    const check = vi.fn(async () => ({ state: 'UNPAID' as const, expiry: null }));

    startMintQuotePolling({
      check,
      onPaid: vi.fn(),
      isActive: () => active,
      intervalMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(1);

    active = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
