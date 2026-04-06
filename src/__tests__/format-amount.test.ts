import { describe, it, expect } from 'vitest';
import { formatAmount, getUnitSymbol, getUnitDecimals } from '../lib/utils';

describe('formatAmount', () => {
  // --- Sats (default) ---
  it('formats sats with thousands separator', () => {
    expect(formatAmount(1000)).toBe('1,000 sat');
  });

  it('formats sats with no decimals', () => {
    expect(formatAmount(1)).toBe('1 sat');
  });

  it('formats zero sats', () => {
    expect(formatAmount(0)).toBe('0 sat');
  });

  it('formats large sat amounts', () => {
    expect(formatAmount(21000000)).toBe('21,000,000 sat');
  });

  it('uses sat as default unit', () => {
    expect(formatAmount(100)).toBe('100 sat');
  });

  // --- USD ---
  it('formats USD with dollar sign prefix and 2 decimals', () => {
    expect(formatAmount(10, 'usd')).toBe('$10.00');
  });

  it('formats USD cents', () => {
    expect(formatAmount(0.5, 'usd')).toBe('$0.50');
  });

  it('formats USD with thousands', () => {
    expect(formatAmount(1234.56, 'usd')).toBe('$1,234.56');
  });

  // --- EUR ---
  it('formats EUR with euro sign prefix and 2 decimals', () => {
    expect(formatAmount(5, 'eur')).toBe('\u20AC5.00');
  });

  // --- GBP ---
  it('formats GBP with pound sign', () => {
    expect(formatAmount(99.99, 'gbp')).toBe('\u00A399.99');
  });

  // --- JPY ---
  it('formats JPY with yen sign and no decimals', () => {
    expect(formatAmount(1500, 'jpy')).toBe('\u00A51,500');
  });

  // --- BTC ---
  it('formats BTC with 8 decimals', () => {
    expect(formatAmount(0.00100000, 'btc')).toBe('0.00100000 BTC');
  });

  // --- msat ---
  it('formats msat with no decimals', () => {
    expect(formatAmount(1000, 'msat')).toBe('1,000 msat');
  });

  // --- Unknown unit ---
  it('formats unknown unit with suffix', () => {
    expect(formatAmount(42, 'xyz')).toBe('42 xyz');
  });

  // --- Case insensitivity ---
  it('handles uppercase unit', () => {
    expect(formatAmount(10, 'USD')).toBe('$10.00');
  });

  it('handles mixed case unit', () => {
    expect(formatAmount(10, 'Sat')).toBe('10 sat');
  });
});

describe('getUnitSymbol', () => {
  it('returns sat for sat', () => {
    expect(getUnitSymbol('sat')).toBe('sat');
  });

  it('returns $ for usd', () => {
    expect(getUnitSymbol('usd')).toBe('$');
  });

  it('returns the unit itself for unknown', () => {
    expect(getUnitSymbol('xyz')).toBe('xyz');
  });
});

describe('getUnitDecimals', () => {
  it('returns 0 for sat', () => {
    expect(getUnitDecimals('sat')).toBe(0);
  });

  it('returns 2 for usd', () => {
    expect(getUnitDecimals('usd')).toBe(2);
  });

  it('returns 8 for btc', () => {
    expect(getUnitDecimals('btc')).toBe(8);
  });

  it('returns 0 for unknown', () => {
    expect(getUnitDecimals('xyz')).toBe(0);
  });
});
