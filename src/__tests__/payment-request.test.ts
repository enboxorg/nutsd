import { describe, it, expect } from 'vitest';
import { isPaymentRequest, decodePaymentRequest, encodePaymentRequest, type PaymentRequest } from '../cashu/payment-request';

describe('isPaymentRequest', () => {
  it('detects creqA prefix', () => {
    expect(isPaymentRequest('creqAeyJhIjoxMDB9')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPaymentRequest('CREQA...')).toBe(true);
  });

  it('rejects cashu tokens', () => {
    expect(isPaymentRequest('cashuA...')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isPaymentRequest('')).toBe(false);
  });
});

describe('encodePaymentRequest / decodePaymentRequest', () => {
  it('round-trips a simple request', () => {
    const req: PaymentRequest = {
      amount: 100,
      unit: 'sat',
      mints: ['https://testnut.cashu.space'],
    };
    const encoded = encodePaymentRequest(req);
    expect(encoded.startsWith('creqA')).toBe(true);

    const decoded = decodePaymentRequest(encoded);
    expect(decoded.amount).toBe(100);
    expect(decoded.unit).toBe('sat');
    expect(decoded.mints).toEqual(['https://testnut.cashu.space']);
  });

  it('round-trips with description and id', () => {
    const req: PaymentRequest = {
      id: 'pay-123',
      amount: 500,
      unit: 'sat',
      mints: ['https://mint1.com', 'https://mint2.com'],
      description: 'Payment for coffee',
    };
    const encoded = encodePaymentRequest(req);
    const decoded = decodePaymentRequest(encoded);
    expect(decoded.id).toBe('pay-123');
    expect(decoded.description).toBe('Payment for coffee');
    expect(decoded.mints).toHaveLength(2);
  });

  it('round-trips zero-amount (any amount) request', () => {
    const req: PaymentRequest = { unit: 'sat', mints: ['https://mint.com'] };
    const encoded = encodePaymentRequest(req);
    const decoded = decodePaymentRequest(encoded);
    expect(decoded.amount).toBe(0);
  });

  it('throws on invalid prefix', () => {
    expect(() => decodePaymentRequest('cashuA...')).toThrow('must start with creqA');
  });

  it('throws on invalid base64', () => {
    expect(() => decodePaymentRequest('creqA!!!invalid')).toThrow('could not decode');
  });

  it('defaults unit to sat when absent', () => {
    const json = btoa(JSON.stringify({ a: 50 }));
    const decoded = decodePaymentRequest('creqA' + json);
    expect(decoded.unit).toBe('sat');
    expect(decoded.amount).toBe(50);
  });
});
