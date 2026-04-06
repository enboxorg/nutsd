import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLnurlWithdrawInfo, submitLnurlWithdraw, msatToSats } from '../lib/lnurl-withdraw';

describe('msatToSats', () => {
  it('converts 1000 msat to 1 sat', () => {
    expect(msatToSats(1000)).toBe(1);
  });
  it('floors fractional sats', () => {
    expect(msatToSats(1500)).toBe(1);
  });
});

describe('fetchLnurlWithdrawInfo', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('parses withdraw info', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag: 'withdrawRequest',
        callback: 'https://example.com/withdraw',
        k1: 'abc123',
        minWithdrawable: 1000,
        maxWithdrawable: 100000,
        defaultDescription: 'Withdraw from service',
      }),
    })) as any;

    const info = await fetchLnurlWithdrawInfo('https://example.com/lnurl');
    expect(info.tag).toBe('withdrawRequest');
    expect(info.callback).toBe('https://example.com/withdraw');
    expect(info.k1).toBe('abc123');
    expect(info.minWithdrawable).toBe(1000);
  });

  it('throws on non-withdraw tag', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag: 'payRequest' }),
    })) as any;

    await expect(fetchLnurlWithdrawInfo('https://example.com')).rejects.toThrow('Expected withdrawRequest');
  });
});

describe('submitLnurlWithdraw', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('submits invoice to callback', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'OK' }),
    })) as any;

    await submitLnurlWithdraw('https://example.com/cb', 'k1abc', 'lnbc100...');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/cb?k1=k1abc&pr=lnbc100...',
    );
  });

  it('throws on error response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ERROR', reason: 'Already withdrawn' }),
    })) as any;

    await expect(submitLnurlWithdraw('https://example.com/cb', 'k1', 'lnbc...')).rejects.toThrow('Already withdrawn');
  });
});
