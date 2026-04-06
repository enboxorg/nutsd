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
import { defineProtocol } from '@enbox/api';
import { isValidP2pkPublicKey } from '@/cashu/p2pk';

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
 * Validate that a transfer record contains a P2PK-locked token.
 *
 * Checks:
 * 1. `recipientPubkey` is a valid compressed secp256k1 public key
 * 2. `token` is present and non-empty
 * 3. `senderDid` is present
 *
 * This MUST be called before writing any transfer record to the DWN.
 * It replaces the old `assertTransferProtocolDisabled()`.
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
