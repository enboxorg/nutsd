import { describe, it, expect } from 'vitest';
import { extractMintUrl, isCashuToken, selectProofs, sumProofs } from '../cashu/token-utils';

// ---------------------------------------------------------------------------
// extractMintUrl
// ---------------------------------------------------------------------------

describe('extractMintUrl', () => {
  it('extracts mint URL from a real V4 (cashuB) token', () => {
    // Real token from testnut.cashu.space
    const token =
      'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlI' +
      'AYhKdLsvxe5hcIKkYWEEYXN4QGJkYjZiZWVlODYxNWJlZjQ4MGNiYjY5ZTAwYzRj' +
      'NTM0ODNkZDkzMWQyNGE3Yjg2NjNlOTFkNzkwZTU2MGRhMDVhY1ghA-k4oHmG2Uc5' +
      'KR1NqdQUCzei7EAUi2QhiR7UdZj5NlESYWSjYWVYIORhv_d2JozpJ67Y3C9WGuWO' +
      'geJwdydGhOJbjCJ4Q0qCYXNYILAsOfIWF4FUnRfNZ32j4mNW4yXeTp5Dh30AW2-t' +
      'nptAYXJYIAhZL6rD-gwO_cjueAW8jMKWNG1xvluMI11H5_v-UH0bpGFhAWFzeEAy' +
      'OWRjOGQ3YTE2ZjgxZTY0OGFkYzM0ZTBkNzU3NDE5ZDYyNTg2MmFjODA1OWYzZWMx' +
      'ZDhmM2U4YTlkMzNkZmZiYWNYIQKtT7C7g1rH61HuWiNLxuaaMXapqYdSFMk4lNG6' +
      'Z0xzL2Fko2FlWCBvX4TDGuDjATiczBImy74QxmgyRlOZg63dHaMDw1ahSGFzWCBp' +
      'g0reLaAGAAcUXab36cH0Q1PTUD9Iw7-isA882-sudWFyWCBEUz7gbYtP6SdF9I6f' +
      'sazdiV-vq4THb8ouF792Gvpi3A';

    const url = extractMintUrl(token);
    expect(url).toBe('https://testnut.cashu.space');
  });

  it('does not include trailing CBOR bytes in V4 URL', () => {
    // The key test: CBOR bytes after the URL (aucsatat...) must not be included
    const url = extractMintUrl(
      'cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlI' +
      'AYhKdLsvxe5hcIKkYWEEYXN4QGJkYjZiZWVlODYxNWJlZjQ4MGNiYjY5ZTAwYzRj' +
      'NTM0ODNkZDkzMWQyNGE3Yjg2NjNlOTFkNzkwZTU2MGRhMDVhY1ghA-k4oHmG2Uc5' +
      'KR1NqdQUCzei7EAUi2QhiR7UdZj5NlESYWSjYWVYIORhv_d2JozpJ67Y3C9WGuWO' +
      'geJwdydGhOJbjCJ4Q0qCYXNYILAsOfIWF4FUnRfNZ32j4mNW4yXeTp5Dh30AW2-t' +
      'nptAYXJYIAhZL6rD-gwO_cjueAW8jMKWNG1xvluMI11H5_v-UH0bpGFhAWFzeEAy' +
      'OWRjOGQ3YTE2ZjgxZTY0OGFkYzM0ZTBkNzU3NDE5ZDYyNTg2MmFjODA1OWYzZWMx' +
      'ZDhmM2U4YTlkMzNkZmZiYWNYIQKtT7C7g1rH61HuWiNLxuaaMXapqYdSFMk4lNG6' +
      'Z0xzL2Fko2FlWCBvX4TDGuDjATiczBImy74QxmgyRlOZg63dHaMDw1ahSGFzWCBp' +
      'g0reLaAGAAcUXab36cH0Q1PTUD9Iw7-isA882-sudWFyWCBEUz7gbYtP6SdF9I6f' +
      'sazdiV-vq4THb8ouF792Gvpi3A',
    );
    expect(url).not.toContain('aucsatat');
    expect(url).toBe('https://testnut.cashu.space');
  });

  it('returns null for invalid input', () => {
    expect(extractMintUrl('')).toBeNull();
    expect(extractMintUrl('not a token')).toBeNull();
    expect(extractMintUrl('cashuBinvalid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCashuToken
// ---------------------------------------------------------------------------

describe('isCashuToken', () => {
  it('recognizes V3 tokens', () => {
    expect(isCashuToken('cashuAeyJ0b2tlbiI6W10sInVuaXQiOiJzYXQifQ==')).toBe(true);
  });

  it('recognizes V4 tokens', () => {
    expect(isCashuToken('cashuBo2FteBtodHRwcw==')).toBe(true);
  });

  it('trims whitespace', () => {
    expect(isCashuToken('  cashuBo2FteBtodHRwcw==  ')).toBe(true);
  });

  it('rejects non-tokens', () => {
    expect(isCashuToken('')).toBe(false);
    expect(isCashuToken('lnbc100n1p')).toBe(false);
    expect(isCashuToken('hello world')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectProofs
// ---------------------------------------------------------------------------

describe('selectProofs', () => {
  const makeProof = (amount: number) => ({
    amount,
    id: 'test-keyset',
    secret: `secret-${amount}-${Math.random()}`,
    C: `C-${amount}`,
  });

  it('returns all proofs when total equals target', () => {
    const proofs = [makeProof(4), makeProof(2), makeProof(1)];
    const result = selectProofs(proofs, 7);
    expect(result.selected.length).toBe(3);
    expect(result.remaining.length).toBe(0);
    expect(result.change).toBe(0);
  });

  it('selects a subset with change', () => {
    const proofs = [makeProof(8), makeProof(4), makeProof(2), makeProof(1)];
    const result = selectProofs(proofs, 5);
    expect(sumProofs(result.selected)).toBeGreaterThanOrEqual(5);
    expect(result.change).toBe(sumProofs(result.selected) - 5);
    expect(result.selected.length + result.remaining.length).toBe(4);
  });

  it('throws on insufficient balance', () => {
    const proofs = [makeProof(2), makeProof(1)];
    expect(() => selectProofs(proofs, 10)).toThrow('Insufficient balance');
  });
});

// ---------------------------------------------------------------------------
// sumProofs
// ---------------------------------------------------------------------------

describe('sumProofs', () => {
  it('sums proof amounts', () => {
    expect(sumProofs([
      { amount: 4, id: '', secret: '', C: '' },
      { amount: 2, id: '', secret: '', C: '' },
      { amount: 1, id: '', secret: '', C: '' },
    ])).toBe(7);
  });

  it('returns 0 for empty array', () => {
    expect(sumProofs([])).toBe(0);
  });
});
