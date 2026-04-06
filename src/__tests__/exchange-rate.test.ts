import { describe, it, expect } from 'vitest';
import { satsToFiat, formatFiat } from '../lib/exchange-rate';

describe('satsToFiat', () => {
  it('returns null when no cache exists', () => {
    expect(satsToFiat(100000, 'usd')).toBe(null);
  });
});

describe('formatFiat', () => {
  it('formats USD', () => {
    expect(formatFiat(42.5, 'usd')).toBe('$42.50');
  });

  it('formats EUR', () => {
    expect(formatFiat(10, 'eur')).toBe('\u20AC10.00');
  });

  it('formats GBP', () => {
    expect(formatFiat(99.99, 'gbp')).toBe('\u00A399.99');
  });
});
