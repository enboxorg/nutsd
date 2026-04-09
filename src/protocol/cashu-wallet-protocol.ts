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
 * ENCRYPTION:
 * Sensitive types (proof, keyset, transaction) have `encryptionRequired: true`.
 * The DWN encrypts record data using protocol-path-derived keys from the
 * tenant DID's X25519 keyAgreement key. Local owner sessions and delegated
 * wallet-connect sessions are both supported by the latest Enbox auth stack.
 *
 * TAG POLICY:
 * Encrypted record types (proof, keyset, transaction) carry NO tags.
 * Tags are stored in plaintext metadata and would leak sensitive information
 * (balances, mint usage, activity types) to the DWN operator. All filtering
 * is done client-side after decryption. Only the unencrypted `mint` type
 * uses tags for efficient server-side queries.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import { defineProtocol } from '@enbox/browser';

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

/**
 * Keyset record — cached mint keyset metadata.
 *
 * Written as children of mint records when a mint is added or keysets rotate.
 * Stores the input fee rate (NUT-02), active status, and unit for each
 * keyset. This enables fee-aware proof selection and multi-unit support.
 */
export type KeysetData = {
  /** Keyset ID (hex string). */
  keysetId: string;
  /** Currency unit. */
  unit: string;
  /** Whether this keyset is currently active at the mint. */
  active: boolean;
  /** Input fee in ppk (parts per thousand). */
  inputFeePpk?: number;
};

/**
 * Individual Cashu proof (ecash token).
 *
 * Each proof is stored as a separate DWN record under its mint's context.
 * This enables granular spending without rewriting entire proof sets.
 *
 * The `state` field tracks the proof lifecycle for crash safety:
 * - `unspent`: available for spending (default, omitted for backward compat)
 * - `pending`: submitted to a mint operation, outcome unknown
 *
 * On startup, proofs in `pending` state are reconciled with the mint via
 * NUT-07. If the mint reports them as UNSPENT, they revert. If SPENT, they
 * are deleted. If still PENDING at the mint, they remain pending.
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
  /**
   * Proof lifecycle state. Defaults to `'unspent'` when absent
   * (backward compat with records written before state tracking).
   */
  state?: ProofState;
  /** Optional DLEQ proof (NUT-12). */
  dleq?: {
    e: string;
    s: string;
    r: string;
  };
  /** Optional witness for spending conditions (NUT-10/11). */
  witness?: string;
};

/** Proof lifecycle state (tracked in encrypted record data, not tags). */
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
   * Claim status for 'send' and 'p2p-send' transactions.
   * - 'pending': token created, waiting for recipient to claim
   * - 'claimed': all proofs are SPENT at the mint (NUT-07)
   * - 'unknown': mint does not support NUT-07 or check failed
   *
   * Undefined for non-send transactions.
   */
  claimStatus?: 'pending' | 'claimed' | 'unknown';
  /** ISO timestamp when the token was confirmed claimed. */
  claimedAt?: string;
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

/**
 * P2PK key pair for NUT-11 Pay-to-Pubkey locking.
 *
 * Stores a secp256k1 keypair used to lock/unlock ecash tokens. The private
 * key is encrypted at the DWN layer (`encryptionRequired: true`). The public
 * key is shared with senders (out-of-band or via P2P transfer protocol).
 *
 * Each wallet has exactly one active P2PK key. When a token is locked to
 * this key, only the holder of the private key can redeem it at the mint.
 * This is the security gate for P2P DWN transfers — without P2PK, a DWN
 * server operator could front-run and steal bearer tokens.
 */
export type P2pkKeyData = {
  /** secp256k1 public key in compressed hex (02... or 03...). */
  publicKey: string;
  /** secp256k1 private key in hex. ENCRYPTED at the DWN layer. */
  privateKey: string;
  /** ISO timestamp when the key was generated. */
  createdAt: string;
};

/**
 * Proof stash — write-ahead log entry for crash-safe proof persistence.
 *
 * Written as a SINGLE DWN record immediately after a mint swap returns new
 * proofs. Contains the full set of proofs from the swap. Individual proof
 * records are then written from the stash. Once all proof records succeed,
 * the stash is deleted.
 *
 * If the app crashes between the mint swap and completing the per-proof
 * writes, `recoverProofStashes()` on next startup finds any remaining
 * stash records, deduplicates against existing proofs (by secret), fills
 * in gaps, and deletes the stash.
 *
 * This pattern reduces the loss window from "N DWN writes must all succeed"
 * to "one DWN write must succeed immediately after the mint response."
 */
export type ProofStashData = {
  /** Mint URL these proofs came from. */
  mintUrl: string;
  /** Mint context ID for storing proof records. */
  mintContextId: string;
  /** Currency unit. */
  unit: string;
  /** Full proof set from the mint swap. */
  proofs: ProofData[];
  /** ISO timestamp when the stash was created. */
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
  p2pkKey: P2pkKeyData;
  proofStash: ProofStashData;
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
    p2pkKey: {
      schema              : 'https://enbox.id/schemas/cashu-wallet/p2pk-key',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,
    },
    proofStash: {
      schema              : 'https://enbox.id/schemas/cashu-wallet/proof-stash',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,
    },
    preference: {
      schema      : 'https://enbox.id/schemas/cashu-wallet/preference',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    // Mint records are NOT encrypted (public URLs / names).
    // Tags allowed here for efficient server-side queries.
    mint: {
      $tags: {
        $allowUndefinedTags : true,
        url                 : { type: 'string' },
        unit                : { type: 'string' },
      },
      // Keyset and proof are encrypted → NO tags.
      // Query by parent mint context, filter client-side after decryption.
      keyset: {},
      proof: {},
    },
    // Transaction is encrypted → NO tags.
    // Query all, sort/filter client-side after decryption.
    transaction: {},
    // P2PK key is encrypted (contains private key). Singleton per wallet.
    p2pkKey: {
      $recordLimit: { max: 1, strategy: 'reject' },
    },
    // Proof stash — WAL entries for crash-safe proof persistence.
    // Normally empty; populated briefly during receive, cleaned up immediately.
    // If any exist on startup, recoverProofStashes() replays them.
    proofStash: {},
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
