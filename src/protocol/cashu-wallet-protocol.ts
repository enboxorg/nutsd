/**
 * Cashu Wallet Protocol -- DWN protocol for storing Cashu ecash wallet state.
 *
 * Stores all wallet data in the user's personal DWN:
 * - Trusted mint configurations
 * - Cached keysets per mint
 * - Individual ecash proofs (one DWN record per proof)
 * - Transaction history
 * - Wallet preferences (singleton)
 *
 * Hierarchy:
 *   mint -> keyset
 *   mint -> proof
 *   transaction (top-level)
 *   preference (top-level, singleton)
 *
 * All records are owner-only (published: false).
 *
 * Sensitive types (proof, keyset, transaction) require DWN-level encryption
 * via `encryptionRequired: true`. The DWN encrypts record data using
 * protocol-path-derived keys from the tenant DID's X25519 keyAgreement key.
 * This means even a DWN server operator cannot read proof secrets, keyset
 * keys, or transaction details.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Trusted mint configuration. */
export type MintData = {
  /** Mint URL (canonical, no trailing slash). */
  url: string;
  /** Human-readable name (user-assigned or from mint info). */
  name?: string;
  /** Currency unit (e.g. "sat", "usd"). */
  unit: string;
  /** Whether this mint is active (shown in UI). */
  active: boolean;
  /** Cached mint info response (NUT-06). */
  info?: Record<string, unknown>;
};

/** Cached keyset for a mint. */
export type KeysetData = {
  /** Keyset ID (hex string). */
  keysetId: string;
  /** Currency unit. */
  unit: string;
  /** Whether this keyset is currently active at the mint. */
  active: boolean;
  /** Input fee in ppk (parts per thousand). */
  inputFeePpk?: number;
  /** The actual keyset keys (amount → pubkey mapping). */
  keys: Record<string, string>;
};

/**
 * Individual Cashu proof (ecash token).
 *
 * Each proof is stored as a separate DWN record under its mint's context.
 * This enables granular spending without rewriting entire proof sets.
 */
export type ProofData = {
  /** Value of this proof in the mint's unit. */
  amount: number;
  /** Keyset ID that signed this proof (hex string). */
  id: string;
  /** Secret message (utf-8 string). */
  secret: string;
  /** Unblinded signature (hex string). */
  C: string;
  /** Optional DLEQ proof. */
  dleq?: {
    e: string;
    s: string;
    r: string;
  };
  /** Optional witness for spending conditions. */
  witness?: string;
};

/** Proof lifecycle state. */
export type ProofState = 'unspent' | 'pending' | 'spent';

/**
 * Transaction history record.
 *
 * SECURITY: The `transaction` type has `encryptionRequired: true`, so all
 * record data (including cashuToken) is encrypted at the DWN layer using
 * protocol-path-derived keys. A DWN server operator cannot read the token.
 *
 * The `cashuToken` field is set for 'send' transactions and cleared
 * (set to undefined) once the token is confirmed spent via NUT-07.
 */
export type TransactionData = {
  /** Transaction type. */
  type: 'mint' | 'melt' | 'send' | 'receive' | 'swap' | 'p2p-send' | 'p2p-receive';
  /** Amount in the mint's unit. */
  amount: number;
  /** Currency unit. */
  unit: string;
  /** Mint URL involved. */
  mintUrl: string;
  /** Transaction status. */
  status: 'pending' | 'completed' | 'failed';
  /**
   * Cashu token string for 'send' transactions.
   * Encrypted at the DWN layer. Cleared once confirmed spent.
   */
  cashuToken?: string;
  /** Recipient DID (for p2p-send). */
  recipientDid?: string;
  /** Sender DID (for p2p-receive). */
  senderDid?: string;
  /** User-provided memo. */
  memo?: string;
  /** ISO timestamp. */
  createdAt: string;
};

/** Wallet-level preferences (singleton). */
export type PreferenceData = {
  /** Default mint URL. */
  defaultMintUrl?: string;
  /** Default currency unit. */
  defaultUnit?: string;
  /** Display currency for fiat conversion. */
  displayCurrency?: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

export type CashuWalletSchemaMap = {
  mint: MintData;
  keyset: KeysetData;
  proof: ProofData;
  transaction: TransactionData;
  preference: PreferenceData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const CashuWalletDefinition = {
  protocol  : 'https://enbox.id/protocols/cashu-wallet',
  published : false,
  types     : {
    mint: {
      schema      : 'https://enbox.id/schemas/cashu-wallet/mint',
      dataFormats : ['application/json'],
    },
    keyset: {
      schema              : 'https://enbox.id/schemas/cashu-wallet/keyset',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,
    },
    proof: {
      schema              : 'https://enbox.id/schemas/cashu-wallet/proof',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,
    },
    transaction: {
      schema              : 'https://enbox.id/schemas/cashu-wallet/transaction',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,
    },
    preference: {
      schema      : 'https://enbox.id/schemas/cashu-wallet/preference',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    mint: {
      $tags: {
        $allowUndefinedTags : true,
        url                 : { type: 'string' },
        unit                : { type: 'string' },
        active              : { type: 'boolean' },
      },
      keyset: {
        $tags: {
          $allowUndefinedTags : true,
          keysetId            : { type: 'string' },
          active              : { type: 'boolean' },
        },
      },
      proof: {
        $tags: {
          $allowUndefinedTags : true,
          amount              : { type: 'number' },
          keysetId            : { type: 'string' },
          state               : { type: 'string', enum: ['unspent', 'pending', 'spent'] },
        },
      },
    },
    transaction: {
      $tags: {
        $requiredTags       : ['type'],
        $allowUndefinedTags : true,
        type                : { type: 'string', enum: ['mint', 'melt', 'send', 'receive', 'swap', 'p2p-send', 'p2p-receive'] },
        mintUrl             : { type: 'string' },
        status              : { type: 'string', enum: ['pending', 'completed', 'failed'] },
      },
    },
    preference: {
      $recordLimit: { max: 1, strategy: 'reject' },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Cashu Wallet protocol for use with `enbox.using()`. */
export const CashuWalletProtocol = defineProtocol(
  CashuWalletDefinition,
  {} as CashuWalletSchemaMap,
);
