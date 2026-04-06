/**
 * Cashu Transfer Protocol -- DWN protocol for P2P ecash transfers between DIDs.
 *
 * Enables DID-to-DID ecash transfers without Lightning. The sender resolves
 * the recipient's DID, locks the token to their P2PK public key (NUT-11),
 * and writes the locked token to the recipient's DWN.
 *
 * SECURITY: Every transfer record MUST contain a P2PK-locked token.
 * `assertP2PKLocked()` validates this before any write. Without P2PK,
 * a DWN operator could front-run the recipient and steal bearer tokens.
 *
 * Flow:
 * 1. Sender resolves recipient DID → gets their P2PK public key
 * 2. Sender locks token to recipient's pubkey via NUT-11
 * 3. Sender writes locked token to recipient's DWN (transfer protocol)
 * 4. Recipient subscribes to transfer protocol → detects incoming
 * 5. Recipient unlocks with private key → swaps for fresh proofs immediately
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import { defineProtocol } from '@enbox/browser';
import { isValidP2pkPublicKey } from '@/cashu/p2pk';
import { isP2pkLockedToken } from '@/cashu/token-utils';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Incoming ecash transfer from another DID. */
export type TransferData = {
  /** Serialized Cashu token string (MUST be NUT-11 P2PK locked). */
  token: string;
  /** Total token amount. */
  amount: number;
  /** Currency unit. */
  unit: string;
  /** Mint URL the token was issued by. */
  mintUrl: string;
  /** Optional memo from sender. */
  memo?: string;
  /** Sender's DID. */
  senderDid: string;
  /** Recipient's P2PK public key the token is locked to. */
  recipientPubkey: string;
};

/** Payment request (shared with potential senders). */
export type PaymentRequestData = {
  /** Requested amount. */
  amount: number;
  /** Currency unit. */
  unit: string;
  /** Accepted mint URLs. */
  mints: string[];
  /** Optional memo/description. */
  memo?: string;
  /** Recipient DID (owner of this request). */
  recipientDid: string;
  /** Recipient's P2PK public key for locking. */
  recipientPubkey: string;
  /** Whether this request has been fulfilled. */
  fulfilled?: boolean;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const CashuTransferDefinition = {
  protocol  : 'https://enbox.id/protocols/cashu-transfer',
  published : true,
  types     : {
    transfer: {
      schema      : 'https://enbox.id/schemas/cashu-transfer/transfer',
      dataFormats : ['application/json'],
    },
    request: {
      schema      : 'https://enbox.id/schemas/cashu-transfer/request',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    transfer: {
      $actions: [
        { who: 'anyone', can: ['create'] },
      ],
    },
    request: {},
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Security enforcement
// ---------------------------------------------------------------------------

/**
 * Validate that a transfer record contains a properly P2PK-locked token.
 *
 * Performs two layers of validation:
 * 1. **Metadata validation**: token present, senderDid present, recipientPubkey
 *    is a valid compressed secp256k1 key.
 * 2. **Token-level verification**: the encoded Cashu token actually contains
 *    NUT-10/11 P2PK spending conditions in its proof secrets. This prevents
 *    a sender from claiming P2PK protection while including unlocked proofs.
 *
 * This MUST be called before writing any transfer record to the DWN.
 *
 * @throws if any validation fails
 */
export function assertP2PKLocked(data: TransferData): void {
  if (!data.token || !data.token.trim()) {
    throw new Error('Transfer token is empty. P2P transfers require a locked Cashu token.');
  }
  if (!data.senderDid || !data.senderDid.trim()) {
    throw new Error('Transfer senderDid is empty.');
  }
  if (!data.recipientPubkey) {
    throw new Error(
      'Transfer is missing recipientPubkey. P2P DWN transfers require NUT-11 ' +
      '(Pay-to-Pubkey) to lock tokens to the recipient\'s public key.',
    );
  }
  if (!isValidP2pkPublicKey(data.recipientPubkey)) {
    throw new Error(
      `Invalid recipientPubkey: ${data.recipientPubkey}. ` +
      'Expected a compressed secp256k1 public key (02... or 03... hex).',
    );
  }
  // Verify the token actually contains P2PK-locked proofs.
  // Without this check, a sender could pass metadata validation while
  // including an unlocked token — which a DWN operator could steal.
  if (!isP2pkLockedToken(data.token)) {
    throw new Error(
      'Transfer token is not P2PK-locked. The Cashu token must contain NUT-11 ' +
      'P2PK spending conditions in all proof secrets. Unlocked tokens cannot ' +
      'be safely transferred via DWN.',
    );
  }
}

// ---------------------------------------------------------------------------
// Schema map & typed protocol export
// ---------------------------------------------------------------------------

export type CashuTransferSchemaMap = {
  transfer: TransferData;
  request: PaymentRequestData;
};

/** Typed Cashu Transfer protocol for use with `enbox.using()`. */
export const CashuTransferProtocol = defineProtocol(
  CashuTransferDefinition,
  {} as CashuTransferSchemaMap,
);
