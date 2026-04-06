import { describe, it, expect } from 'vitest';
import { decodeInvoice, formatInvoiceAmount, formatTimeRemaining } from '../cashu/invoice-decode';

describe('decodeInvoice', () => {
  it('decodes mainnet invoice prefix', () => {
    // lnbc100n = 100 nano-BTC = 10 sat
    const result = decodeInvoice('lnbc100n1pjtest');
    expect(result.prefix).toBe('lnbc');
    expect(result.amountSats).toBe(10);
  });

  it('decodes testnet invoice prefix', () => {
    const result = decodeInvoice('lntb200u1pjtest');
    expect(result.prefix).toBe('lntb');
  });

  it('decodes micro-BTC amounts', () => {
    // 1u = 1 micro-BTC = 100 sat
    const result = decodeInvoice('lnbc1u1pjtest');
    expect(result.amountSats).toBe(100);
  });

  it('decodes milli-BTC amounts', () => {
    // 1m = 1 milli-BTC = 100,000 sat
    const result = decodeInvoice('lnbc1m1pjtest');
    expect(result.amountSats).toBe(100000);
  });

  it('returns null amount for no-amount invoice', () => {
    // Just prefix + separator
    const result = decodeInvoice('lnbc1pjtest');
    expect(result.amountSats).toBe(null);
  });

  it('handles unknown prefix gracefully', () => {
    const result = decodeInvoice('xyz123');
    expect(result.prefix).toBe('unknown');
    expect(result.amountSats).toBe(null);
  });

  it('handles pico-BTC amounts', () => {
    // 10p = 10 pico-BTC = 0.001 sat = 1 msat
    const result = decodeInvoice('lnbc10p1pjtest');
    expect(result.amountMsat).toBe(1);
    expect(result.amountSats).toBe(0);
  });
});

describe('formatInvoiceAmount', () => {
  it('formats sat amount', () => {
    expect(formatInvoiceAmount({ amountSats: 1000 } as any)).toBe('1,000 sat');
  });

  it('returns "Any amount" for null', () => {
    expect(formatInvoiceAmount({ amountSats: null } as any)).toBe('Any amount');
  });
});

describe('formatTimeRemaining', () => {
  it('formats seconds', () => {
    expect(formatTimeRemaining(45)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatTimeRemaining(125)).toBe('2m 5s');
  });

  it('formats hours', () => {
    expect(formatTimeRemaining(3725)).toBe('1h 2m');
  });

  it('returns Expired for zero or negative', () => {
    expect(formatTimeRemaining(0)).toBe('Expired');
    expect(formatTimeRemaining(-10)).toBe('Expired');
  });
});
