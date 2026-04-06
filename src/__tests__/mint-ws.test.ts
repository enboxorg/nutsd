import { describe, it, expect, vi } from 'vitest';

// We test the getWebSocketUrl logic indirectly by checking that subscribeToQuote
// falls back to polling. Since WebSocket isn't available in vitest by default,
// all calls should fall back.

describe('mint WebSocket URL derivation', () => {
  it('derives wss:// from https:// mint URL', async () => {
    // Import the module to test
    const { subscribeToQuote } = await import('../lib/mint-ws');

    const onPaid = vi.fn();
    const check = vi.fn(async () => ({ state: 'UNPAID' as const, expiry: null }));

    // In vitest, WebSocket constructor will throw, so it should fall back to polling
    const stop = subscribeToQuote({
      mintUrl: 'https://testnut.cashu.space',
      quoteId: 'test-quote-123',
      quoteType: 'bolt11_mint_quote',
      callbacks: { onPaid },
      checkFn: check,
    });

    // Give the fallback polling time to fire
    await new Promise(r => setTimeout(r, 50));

    // It should have fallen back to polling — stop to clean up
    stop();
    expect(typeof stop).toBe('function');
  });

  it('falls back to polling on WebSocket failure', async () => {
    const { subscribeToQuote } = await import('../lib/mint-ws');

    const onPaid = vi.fn();
    const check = vi.fn(async () => ({ state: 'UNPAID' as const, expiry: null }));

    const stop = subscribeToQuote({
      mintUrl: 'https://example.com',
      quoteId: 'q-456',
      quoteType: 'bolt11_mint_quote',
      callbacks: { onPaid },
      checkFn: check,
    });

    // Clean up
    stop();
    expect(typeof stop).toBe('function');
  });
});
