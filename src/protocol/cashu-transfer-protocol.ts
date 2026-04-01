/**
 * Cashu Transfer Protocol -- DWN protocol for P2P ecash transfers between DIDs.
 *
 * Enables sending Cashu tokens to another DID's DWN. The recipient's wallet
 * subscribes to incoming transfers and auto-claims them by swapping with
 * the mint.
 *
 * SECURITY WARNING -- NUT-11 P2PK REQUIRED FOR SAFE USE:
 * In the current implementation, transfer records contain raw Cashu token
 * strings. These are bearer instruments: anyone who can read the token can
 * claim it. If a DWN is operated by a third party, the operator could
 * front-run the recipient and steal the ecash.
 *
 * Safe P2P transfers MUST lock the token to the recipient's public key
 * using NUT-11 (Pay-to-Pubkey) before writing it to the DWN. This ensures
 * only the holder of the recipient DID's private key can spend the proofs.
 * NUT-11 support is planned but not yet implemented.
 *
 * Until NUT-11 is implemented, this protocol should only be used between
 * DIDs that operate their own DWN (self-hosted), where the operator and
 * the recipient are the same entity.
 *
 * Types:
 *   - transfer: An incoming ecash token sent by another DID
 *   - request: A payment request advertising accepted mints and amount
 *
 * Access control:
 *   - transfer: anyone can create (send you ecash), only author can read their own
 *   - request: only the owner can manage their own requests
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Incoming ecash transfer from another DID. */
export type TransferData = {
  /** Serialized Cashu token string (cashuA... or cashuB...). */
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
  /** Whether this request has been fulfilled. */
  fulfilled?: boolean;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

export type CashuTransferSchemaMap = {
  transfer: TransferData;
  request: PaymentRequestData;
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
        // Anyone can send ecash to this DID
        { who: 'anyone', can: ['create'] },
      ],
      $tags: {
        $allowUndefinedTags : true,
        amount              : { type: 'number' },
        mintUrl             : { type: 'string' },
        senderDid           : { type: 'string' },
        claimed             : { type: 'boolean' },
      },
    },
    request: {
      $tags: {
        $allowUndefinedTags : true,
        amount              : { type: 'number' },
        unit                : { type: 'string' },
        fulfilled           : { type: 'boolean' },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Cashu Transfer protocol for use with `enbox.using()`. */
export const CashuTransferProtocol = defineProtocol(
  CashuTransferDefinition,
  {} as CashuTransferSchemaMap,
);
