import { describe, it, expect } from 'vitest';
import { detectInput } from '../lib/input-detect';

describe('detectInput', () => {
  // --- NUT-18 Payment requests ---
  it('detects NUT-18 payment request (creqA)', () => {
    const result = detectInput('creqAeyJhIjoxMDB9');
    expect(result.type).toBe('payment-request');
  });

  // --- Cashu tokens ---
  it('detects V3 cashu token (cashuA)', () => {
    const result = detectInput('cashuAeyJ0b2tlbiI6W10sInVuaXQiOiJzYXQifQ==');
    expect(result.type).toBe('cashu-token');
    expect(result.value).toBe('cashuAeyJ0b2tlbiI6W10sInVuaXQiOiJzYXQifQ==');
  });

  it('detects V4 cashu token (cashuB)', () => {
    const result = detectInput('cashuBo2FteBtodHRwcw==');
    expect(result.type).toBe('cashu-token');
  });

  it('detects cashu token with whitespace', () => {
    const result = detectInput('  cashuBo2FteBtodHRwcw==  ');
    expect(result.type).toBe('cashu-token');
    expect(result.value).toBe('cashuBo2FteBtodHRwcw==');
  });

  // --- Lightning invoices ---
  it('detects mainnet Lightning invoice (lnbc)', () => {
    const result = detectInput('lnbc100n1pj9nr4dpp5abc123');
    expect(result.type).toBe('lightning-invoice');
  });

  it('detects testnet Lightning invoice (lntb)', () => {
    const result = detectInput('lntb100n1pj9nr4dpp5abc123');
    expect(result.type).toBe('lightning-invoice');
  });

  it('detects signet Lightning invoice (lnbs)', () => {
    const result = detectInput('lnbs100n1pj9nr4dpp5abc123');
    expect(result.type).toBe('lightning-invoice');
  });

  it('handles lightning: URI scheme', () => {
    const result = detectInput('lightning:lnbc100n1pj9nr4dpp5abc123');
    expect(result.type).toBe('lightning-invoice');
    expect(result.value).toBe('lnbc100n1pj9nr4dpp5abc123');
  });

  // --- LNURL ---
  it('detects LNURL bech32 string', () => {
    const result = detectInput('lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns');
    expect(result.type).toBe('lnurl');
  });

  // --- Lightning addresses ---
  it('detects Lightning address', () => {
    const result = detectInput('user@getalby.com');
    expect(result.type).toBe('lightning-address');
    expect(result.value).toBe('user@getalby.com');
  });

  it('detects Lightning address with dots and hyphens', () => {
    const result = detectInput('my.name@pay.bitcoin-server.org');
    expect(result.type).toBe('lightning-address');
  });

  it('rejects email-like strings without valid domain', () => {
    const result = detectInput('user@');
    expect(result.type).toBe('unknown');
  });

  it('rejects strings with multiple @', () => {
    const result = detectInput('user@@domain.com');
    expect(result.type).toBe('unknown');
  });

  // --- Mint URLs ---
  it('detects https mint URL', () => {
    const result = detectInput('https://testnut.cashu.space');
    expect(result.type).toBe('mint-url');
    expect(result.value).toBe('https://testnut.cashu.space');
  });

  it('detects http mint URL', () => {
    const result = detectInput('http://localhost:3338');
    expect(result.type).toBe('mint-url');
  });

  it('normalizes mint URL (strips trailing slash)', () => {
    const result = detectInput('https://testnut.cashu.space/');
    expect(result.type).toBe('mint-url');
    expect(result.value).toBe('https://testnut.cashu.space');
  });

  it('adds https:// to bare domain', () => {
    const result = detectInput('testnut.cashu.space');
    expect(result.type).toBe('mint-url');
    expect(result.value).toBe('https://testnut.cashu.space');
  });

  // --- DIDs ---
  it('detects did:dht identifier', () => {
    const result = detectInput('did:dht:1wiaaaoagbejjznwn5s1ukjntjzgt69ucn8aozdtbr78yhnwdpty');
    expect(result.type).toBe('did');
    expect(result.value).toBe('did:dht:1wiaaaoagbejjznwn5s1ukjntjzgt69ucn8aozdtbr78yhnwdpty');
  });

  it('detects did:web identifier', () => {
    const result = detectInput('did:web:example.com');
    expect(result.type).toBe('did');
  });

  it('detects did:key identifier', () => {
    const result = detectInput('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH');
    expect(result.type).toBe('did');
  });

  it('trims whitespace on DID', () => {
    const result = detectInput('  did:dht:abc123  ');
    expect(result.type).toBe('did');
    expect(result.value).toBe('did:dht:abc123');
  });

  it('rejects malformed DID without method', () => {
    const result = detectInput('did::abc');
    expect(result.type).toBe('unknown');
  });

  it('rejects DID with whitespace in identifier', () => {
    const result = detectInput('did:dht:abc 123');
    expect(result.type).toBe('unknown');
  });

  it('rejects bare "did:" with no method or id', () => {
    const result = detectInput('did:');
    expect(result.type).toBe('unknown');
  });

  // --- Unknown ---
  it('returns unknown for empty string', () => {
    expect(detectInput('').type).toBe('unknown');
  });

  it('returns unknown for random text', () => {
    expect(detectInput('hello world').type).toBe('unknown');
  });

  it('returns unknown for numbers', () => {
    expect(detectInput('12345').type).toBe('unknown');
  });

  // --- Priority order ---
  it('cashu token takes priority over everything', () => {
    // cashuA prefix should match even if it looks like something else
    expect(detectInput('cashuAhttps://test').type).toBe('cashu-token');
  });

  it('lightning invoice takes priority over URL', () => {
    expect(detectInput('lnbc100https://test').type).toBe('lightning-invoice');
  });

  it('DID takes priority over mint URL even with dots', () => {
    // did:web:example.com could look like a mint URL; DID must win
    expect(detectInput('did:web:example.com').type).toBe('did');
  });
});
