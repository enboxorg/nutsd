# nutsd

**Decentralized Cashu ecash wallet powered by Enbox.**

nutsd is a Cashu ecash wallet that stores your wallet state in your personal [Decentralized Web Node (DWN)](https://identity.foundation/decentralized-web-node/spec/) instead of a centralized server or local-only browser storage. Your proofs, mints, and transaction history live in DWN records you control — synced across devices, owned by your DID. Sensitive record types (proofs, keysets, transactions) require DWN-level encryption (`encryptionRequired: true`), so even the DWN server operator cannot read your ecash secrets.

**Live:** [nutsd.pages.dev](https://nutsd.pages.dev) &middot; [dnuts.pages.dev](https://dnuts.pages.dev)

---

## What makes nutsd different

Every other Cashu wallet stores your ecash proofs in localStorage, a mobile app's sandbox, or a cloud database controlled by the wallet provider. If you clear your browser, lose your phone, or the service shuts down — your tokens are gone.

nutsd takes a different approach:

| | Traditional Cashu Wallets | nutsd |
|---|---|---|
| **Storage** | localStorage / app sandbox / cloud DB | Your personal DWN (private, encrypted sensitive types) |
| **Identity** | None or custodial accounts | Decentralized Identifiers (DIDs) |
| **Multi-device** | Manual backup / restore | Automatic DWN sync |
| **Portability** | Locked to one app | Any DWN-compatible app can read your wallet |
| **P2P transfers** | Copy-paste tokens or Lightning | Send ecash directly to a DID (planned) |
| **Interop** | Isolated ecosystems | Open DWN protocols anyone can build on |

### How it works

1. **Connect** with a DID — either by connecting an Enbox wallet (delegated wallet-connect) or by creating a local identity
2. **DWN protocols** define the schema for your wallet data (mints, proofs, transactions) as typed records in your personal data store — proofs, keysets, and transactions are encrypted at the DWN layer
3. **Cashu operations** (mint, melt, send, receive) are handled by [cashu-ts](https://github.com/cashubtc/cashu-ts), with proof lifecycle managed through DWN records
4. **Real-time sync** — subscribe to protocol-level changes so multi-device state stays consistent

The wallet defines two open DWN protocols:

- **`cashu-wallet`** — private protocol storing mint configurations, keysets, individual proofs (one record per proof), transaction history, and preferences
- **`cashu-transfer`** — published protocol enabling P2P ecash transfers between DIDs (anyone can send you a token by writing to your DWN)

---

## Features

- **Multi-mint** — connect to multiple Cashu mints simultaneously, view per-mint balances
- **Deposit** — mint ecash by paying a Lightning invoice (NUT-04)
- **Withdraw** — melt ecash to pay a Lightning invoice (NUT-05)
- **Send** — create a Cashu token to share with anyone
- **Receive** — claim a Cashu V3 or V4 token
- **Token status** — check if a sent token has been claimed (NUT-07)
- **Mint detail** — view mint info, pubkey, supported NUTs, and connection details
- **Dark/light theme** — Enbox design language with dark-first aesthetic
- **PWA** — installable, works offline, service worker with Enbox polyfills

---

## Quick start

```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Production build
pnpm build

# Preview production build
pnpm preview
```

### Branded variants

nutsd supports build-time branding via the `VITE_PRODUCT_THEME` environment variable. The same codebase produces multiple themed deployments:

| Variant | Theme | Accent | URL |
|---------|-------|--------|-----|
| **nutsd** | _(default)_ | Gold | [nutsd.pages.dev](https://nutsd.pages.dev) |
| **dnuts** | `dnuts` | Teal | [dnuts.pages.dev](https://dnuts.pages.dev) |

```bash
# Build the default (nutsd) variant
pnpm build

# Build the dnuts variant
VITE_PRODUCT_THEME=dnuts pnpm build
```

### Deploy to Cloudflare Pages

```bash
# Deploy nutsd
pnpm build
npx wrangler pages deploy dist --project-name nutsd --branch main

# Deploy dnuts
VITE_PRODUCT_THEME=dnuts pnpm build
npx wrangler pages deploy dist --project-name dnuts --branch main
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                nutsd (React PWA)                  │
│                                                   │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  Wallet UI │ │   Mint     │ │  Transaction │  │
│  │  (dialogs) │ │  Detail    │ │  History     │  │
│  └─────┬──────┘ └─────┬──────┘ └──────┬───────┘  │
│        └──────────────┼───────────────┘           │
│                  ┌────┴────┐                      │
│                  │  Hooks  │  useWallet()          │
│                  └────┬────┘                      │
│        ┌──────────────┼──────────────┐            │
│   ┌────┴─────┐  ┌─────┴──────┐ ┌────┴──────┐     │
│   │ cashu-ts │  │ @enbox/api │ │ Protocols │     │
│   │ Wallet   │  │ repository │ │ (DWN)     │     │
│   └──────────┘  └─────┬──────┘ └───────────┘     │
└────────────────────────┼─────────────────────────┘
                         │
             ┌───────────┴───────────┐
             │    User's DWN         │
             │  (encrypted records)  │
             │  mint / keyset        │
             │  proof (one per rec)  │
             │  transaction          │
             │  preference           │
             └───────────────────────┘
```

### Key files

| Path | Purpose |
|------|---------|
| `src/protocol/cashu-wallet-protocol.ts` | DWN protocol definition for wallet state |
| `src/protocol/cashu-transfer-protocol.ts` | DWN protocol for P2P ecash transfers |
| `src/cashu/wallet-ops.ts` | cashu-ts wrapper (mint, melt, swap, receive) |
| `src/cashu/token-utils.ts` | Token parsing, encoding, proof selection |
| `src/hooks/use-wallet.ts` | React hook bridging DWN records and Cashu ops |
| `src/enbox/EnboxProvider.tsx` | Auth context (DID connect, session restore) |
| `src/lib/brand.ts` | Build-time brand configuration |

---

## Tech stack

- [React 18](https://react.dev) + [Vite](https://vite.dev) + [TypeScript](https://www.typescriptlang.org)
- [Tailwind CSS](https://tailwindcss.com) with [Enbox design tokens](https://github.com/enboxorg/design)
- [@cashu/cashu-ts](https://github.com/cashubtc/cashu-ts) — Cashu protocol library
- [@enbox/api](https://www.npmjs.com/package/@enbox/api) + [@enbox/auth](https://www.npmjs.com/package/@enbox/auth) — DWN identity and data
- [Workbox](https://developer.chrome.com/docs/workbox) — PWA service worker

---

## Cashu protocol support

| NUT | Description | Status |
|-----|-------------|--------|
| [00](https://github.com/cashubtc/nuts/blob/main/00.md) | Cryptography and models | Supported |
| [01](https://github.com/cashubtc/nuts/blob/main/01.md) | Mint public keys | Supported |
| [02](https://github.com/cashubtc/nuts/blob/main/02.md) | Keyset IDs | Supported |
| [03](https://github.com/cashubtc/nuts/blob/main/03.md) | Token format (V3 + V4) | Supported |
| [04](https://github.com/cashubtc/nuts/blob/main/04.md) | Minting (Lightning deposit) | Supported |
| [05](https://github.com/cashubtc/nuts/blob/main/05.md) | Melting (Lightning withdraw) | Supported |
| [06](https://github.com/cashubtc/nuts/blob/main/06.md) | Mint info | Supported |
| [07](https://github.com/cashubtc/nuts/blob/main/07.md) | Token state check | Supported |
| [11](https://github.com/cashubtc/nuts/blob/main/11.md) | Pay-to-Pubkey (P2PK) | Planned |
| [13](https://github.com/cashubtc/nuts/blob/main/13.md) | Deterministic secrets | Planned |

---

## Security model

### What is protected

- **Proof secrets, keyset keys, and transaction details** (including sent Cashu token strings) are stored in DWN record types with `encryptionRequired: true`. The DWN encrypts these using protocol-path-derived keys from the tenant DID's X25519 keyAgreement key. A DWN server operator cannot read them.
- **Sent token strings** are stored encrypted in the transaction record so they can be re-copied and spend-checked across sessions and devices. Once a sent token is confirmed spent (NUT-07), the token is cleared from the record -- it's no longer needed.
- **Mint configurations** are stored without encryption (they contain only public URLs and names).

### What is not yet implemented

- **NUT-11 P2PK (Pay-to-Pubkey)**: The P2P transfer protocol (`cashu-transfer-protocol.ts`) stores raw bearer tokens. Until NUT-11 locks tokens to the recipient DID's public key, DWN-mediated transfers are safe only when the recipient operates their own DWN. NUT-11 support is planned.
- **NUT-13 deterministic secrets**: Proofs use random secrets. If DWN data is lost, funds cannot be independently recovered from a seed phrase the way they can in reference wallets. The recovery phrase shown during setup recovers the DID and DWN data, not the Cashu proofs directly. NUT-13 support is planned.
- **NUT-09 signature restore**: Not yet implemented. Would allow recovering proofs from a mint using deterministic secrets.

---

## License

MIT
