import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLightningAddress, requestLnurlInvoice, msatToSats, satsToMsat } from '../lib/lnurl';

// --- Unit conversion ---

describe('msatToSats', () => {
  it('converts 1000 msat to 1 sat', () => {
    expect(msatToSats(1000)).toBe(1);
  });

  it('converts 1500 msat to 1 sat (floor)', () => {
    expect(msatToSats(1500)).toBe(1);
  });

  it('converts 0 to 0', () => {
    expect(msatToSats(0)).toBe(0);
  });

  it('converts large values', () => {
    expect(msatToSats(100_000_000)).toBe(100_000);
  });
});

describe('satsToMsat', () => {
  it('converts 1 sat to 1000 msat', () => {
    expect(satsToMsat(1)).toBe(1000);
  });

  it('converts 0 to 0', () => {
    expect(satsToMsat(0)).toBe(0);
  });

  it('converts large values', () => {
    expect(satsToMsat(21_000_000)).toBe(21_000_000_000);
  });
});

// --- LNURL resolution ---

describe('resolveLightningAddress', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects invalid address (no @)', async () => {
    await expect(resolveLightningAddress('invalid')).rejects.toThrow('Invalid Lightning address');
  });

  it('rejects address with empty user', async () => {
    await expect(resolveLightningAddress('@domain.com')).rejects.toThrow('Invalid Lightning address');
  });

  it('rejects address with empty domain', async () => {
    await expect(resolveLightningAddress('user@')).rejects.toThrow('Invalid Lightning address');
  });

  it('fetches .well-known/lnurlp/{user} endpoint', async () => {
    const mockResponse = {
      tag: 'payRequest',
      minSendable: 1000,
      maxSendable: 100000000,
      callback: 'https://getalby.com/lnurlp/user/callback',
      metadata: '[["text/plain","Pay user"]]',
    };

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    })) as any;

    const result = await resolveLightningAddress('user@getalby.com');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://getalby.com/.well-known/lnurlp/user',
    );
    expect(result.minSendable).toBe(1000);
    expect(result.maxSendable).toBe(100000000);
    expect(result.callback).toBe('https://getalby.com/lnurlp/user/callback');
    expect(result.displayName).toBe('Pay user');
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
    })) as any;

    await expect(resolveLightningAddress('user@bad.com')).rejects.toThrow('LNURL endpoint failed: 404');
  });

  it('throws on LNURL error response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ERROR', reason: 'User not found' }),
    })) as any;

    await expect(resolveLightningAddress('user@err.com')).rejects.toThrow('User not found');
  });

  it('throws LnurlWithdrawDetectedError on withdrawRequest tag', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag: 'withdrawRequest' }),
    })) as any;

    await expect(resolveLightningAddress('user@withdraw.com')).rejects.toThrow('LNURL-withdraw');
  });
});

describe('requestLnurlInvoice', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('appends amount as query parameter', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ pr: 'lnbc100n1...' }),
    })) as any;

    const invoice = await requestLnurlInvoice('https://example.com/callback', 5000);

    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/callback?amount=5000');
    expect(invoice).toBe('lnbc100n1...');
  });

  it('uses & if callback already has query params', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ pr: 'lnbc200n1...' }),
    })) as any;

    await requestLnurlInvoice('https://example.com/callback?tag=pay', 10000);

    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/callback?tag=pay&amount=10000');
  });

  it('throws on LNURL error', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ERROR', reason: 'Amount too low' }),
    })) as any;

    await expect(requestLnurlInvoice('https://err.com/cb', 100)).rejects.toThrow('Amount too low');
  });

  it('throws if no invoice returned', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as any;

    await expect(requestLnurlInvoice('https://no-pr.com/cb', 5000)).rejects.toThrow('did not return an invoice');
  });
});
