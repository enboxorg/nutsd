/**
 * Cashu Transfer Protocol -- DWN protocol for P2P ecash transfers between DIDs.
 *
 * STATUS: DISABLED / NOT INSTALLED
 *
 * This protocol is defined but NOT installed or used. It is blocked at the
 * application layer because safe P2P transfers require NUT-11 (Pay-to-Pubkey)
 * to lock tokens to the recipient's DID public key before writing them to
 * the DWN. Without P2PK, a DWN operator can front-run the recipient and
 * steal the bearer ecash.
 *
 * The protocol definition is kept here as a design reference for when NUT-11
 * support is implemented. To enable it:
 * 1. Implement NUT-11 P2PK token locking using the recipient DID's key
 * 2. Re-add the protocol to the connect flow in EnboxProvider
 * 3. Build the transfer UI
 *
 * DO NOT install this protocol or write transfer records without P2PK.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Data types (design reference only — not active)
// ---------------------------------------------------------------------------

/** Incoming ecash transfer from another DID. */
export type TransferData = {
  /** Serialized Cashu token string (must be NUT-11 P2PK locked). */
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
// Protocol definition (design reference — NOT installed)
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

/**
 * Runtime guard: throws if anyone attempts to use the transfer protocol.
 * This ensures no code path can accidentally write unprotected bearer tokens.
 */
export function assertTransferProtocolDisabled(): never {
  throw new Error(
    'cashu-transfer protocol is disabled. P2P DWN transfers require NUT-11 ' +
    '(Pay-to-Pubkey) to lock tokens to the recipient DID. Without P2PK, a ' +
    'DWN operator can steal bearer tokens. See cashu-transfer-protocol.ts.',
  );
}
