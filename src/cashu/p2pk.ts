/**
 * NUT-11 Pay-to-Pubkey (P2PK) key management and token operations.
 *
 * Provides secp256k1 keypair generation, P2PK-locked token creation,
 * and locked token reception. Keys are stored encrypted in the DWN.
 *
 * Security: The private key MUST be encrypted at the DWN layer.
 * It is a bearer credential — anyone with the private key can redeem
 * tokens locked to the corresponding public key.
 *
 * @module
 */

import * as secp256k1 from '@noble/secp256k1';
import { getWallet } from './wallet-ops';
import type { Proof } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export type P2pkKeyPair = {
  /** Compressed secp256k1 public key in hex (02... or 03...). */
  publicKey: string;
  /** secp256k1 private key in hex. */
  privateKey: string;
};

/**
 * Generate a new secp256k1 keypair for NUT-11 P2PK.
 *
 * Uses `crypto.getRandomValues` for entropy (browser-safe).
 */
export function generateP2pkKeyPair(): P2pkKeyPair {
  const privateKeyBytes = secp256k1.utils.randomPrivateKey();
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true); // compressed
  return {
    publicKey  : bytesToHex(publicKeyBytes),
    privateKey : bytesToHex(privateKeyBytes),
  };
}

/**
 * Derive the compressed public key from a private key.
 */
export function publicKeyFromPrivate(privateKeyHex: string): string {
  const pubBytes = secp256k1.getPublicKey(hexToBytes(privateKeyHex), true);
  return bytesToHex(pubBytes);
}

/**
 * Validate that a hex string is a valid compressed secp256k1 public key.
 */
export function isValidP2pkPublicKey(hex: string): boolean {
  try {
    if (!/^0[23][0-9a-fA-F]{64}$/.test(hex)) return false;
    // Try to parse as a point on the curve
    secp256k1.ProjectivePoint.fromHex(hex);
    return true;
  } catch {
    // Expected: invalid hex or point not on curve
    return false;
  }
}

// ---------------------------------------------------------------------------
// P2PK token operations
// ---------------------------------------------------------------------------

/**
 * Create P2PK-locked proofs for a recipient's public key.
 *
 * Uses cashu-ts `wallet.ops.send().asP2PK()` to lock the tokens
 * to the recipient's secp256k1 public key. Only the holder of the
 * corresponding private key can redeem them.
 *
 * @param mintUrl - Mint URL
 * @param proofs - Available proofs to spend from
 * @param amount - Amount to lock
 * @param recipientPubkey - Recipient's compressed secp256k1 public key (hex)
 * @param unit - Currency unit
 * @returns P2PK-locked send proofs and change proofs
 */
export async function sendP2pkLocked(
  mintUrl: string,
  proofs: Proof[],
  amount: number,
  recipientPubkey: string,
  unit = 'sat',
): Promise<{ send: Proof[]; keep: Proof[] }> {
  if (!isValidP2pkPublicKey(recipientPubkey)) {
    throw new Error('Invalid recipient P2PK public key');
  }
  const wallet = await getWallet(mintUrl, unit);
  const result = await wallet.ops
    .send(amount, proofs)
    .asP2PK({ pubkey: recipientPubkey })
    .includeFees(true)
    .run();
  return { send: result.send, keep: result.keep };
}

/**
 * Receive (redeem) P2PK-locked proofs using the private key.
 *
 * Passes the private key to cashu-ts which creates the NUT-11
 * spending condition witness and swaps with the mint.
 *
 * @param mintUrl - Mint URL
 * @param encodedToken - Encoded Cashu token (P2PK-locked)
 * @param privateKey - secp256k1 private key (hex)
 * @param unit - Currency unit
 * @returns Fresh (unlocked) proofs
 */
export async function receiveP2pkLocked(
  mintUrl: string,
  encodedToken: string,
  privateKey: string,
  unit = 'sat',
): Promise<Proof[]> {
  const wallet = await getWallet(mintUrl, unit);
  return wallet.receive(encodedToken, { privkey: privateKey });
}

// ---------------------------------------------------------------------------
// Hex utilities
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
