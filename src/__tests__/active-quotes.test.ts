import { describe, it, expect, beforeEach } from 'vitest';
import { registerActiveQuote, unregisterActiveQuote, isQuoteActive } from '../lib/active-quotes';

describe('active-quotes registry', () => {
  // Registry is module-level state — clean up after each test
  const tracked: string[] = [];
  beforeEach(() => {
    for (const id of tracked) unregisterActiveQuote(id);
    tracked.length = 0;
  });

  function register(id: string) {
    registerActiveQuote(id);
    tracked.push(id);
  }

  it('registers and queries a quote', () => {
    expect(isQuoteActive('q1')).toBe(false);
    register('q1');
    expect(isQuoteActive('q1')).toBe(true);
  });

  it('unregisters a quote', () => {
    register('q1');
    unregisterActiveQuote('q1');
    tracked.pop();
    expect(isQuoteActive('q1')).toBe(false);
  });

  it('handles multiple quotes independently', () => {
    register('q1');
    register('q2');
    expect(isQuoteActive('q1')).toBe(true);
    expect(isQuoteActive('q2')).toBe(true);

    unregisterActiveQuote('q1');
    tracked.shift();
    expect(isQuoteActive('q1')).toBe(false);
    expect(isQuoteActive('q2')).toBe(true);
  });

  it('unregister is idempotent', () => {
    register('q1');
    unregisterActiveQuote('q1');
    unregisterActiveQuote('q1'); // no-op, no throw
    tracked.pop();
    expect(isQuoteActive('q1')).toBe(false);
  });

  it('register is idempotent (Set semantics)', () => {
    register('q1');
    registerActiveQuote('q1'); // duplicate
    unregisterActiveQuote('q1');
    tracked.pop();
    expect(isQuoteActive('q1')).toBe(false);
  });
});
