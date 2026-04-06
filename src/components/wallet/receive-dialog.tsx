import { useState, useEffect, useRef } from 'react';
import { Loader2Icon, XIcon, DownloadIcon, ZapIcon, CopyIcon, CheckIcon, ChevronDownIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl } from '@/lib/utils';
import { receiveToken, createMintQuote, checkMintQuote, mintTokens, isTokenSpendable } from '@/cashu/wallet-ops';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { subscribeToQuote } from '@/lib/mint-ws';
import { extractMintUrl, isCashuToken, isP2pkLockedToken, parseToken } from '@/cashu/token-utils';
import { receiveP2pkLocked } from '@/cashu/p2pk';
import { QRCodeDisplay } from '@/components/qr-code';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import type { Mint } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface ReceiveDialogProps {
  mints: Mint[];
  /** P2PK private key for unlocking locked tokens. */
  p2pkPrivateKey?: string;
  /** Called when the token is from an unknown mint. Parent should show trust dialog. */
  onUnknownMint?: (mintUrl: string, amount: number, unit: string, token: string) => void;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Tab = 'token' | 'lightning';

export const ReceiveDialog: React.FC<ReceiveDialogProps> = ({
  mints,
  p2pkPrivateKey,
  onUnknownMint,
  onClose,
  onProofsReceived,
  onTransactionCreated,
}) => {
  const [tab, setTab] = useState<Tab>('token');

  return (
    <DialogWrapper open={true} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DownloadIcon className="h-5 w-5 text-[var(--color-info)]" />
            <h3 className="text-lg font-semibold">Receive</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Tab selector */}
        <div className="flex rounded-lg bg-muted p-0.5">
          <button
            onClick={() => setTab('token')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === 'token' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Ecash Token
          </button>
          <button
            onClick={() => setTab('lightning')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === 'lightning' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <ZapIcon className="h-3 w-3" />
            Lightning
          </button>
        </div>

        {tab === 'token' && (
          <TokenTab
            mints={mints}
            p2pkPrivateKey={p2pkPrivateKey}
            onUnknownMint={onUnknownMint}
            onClose={onClose}
            onProofsReceived={onProofsReceived}
            onTransactionCreated={onTransactionCreated}
          />
        )}

        {tab === 'lightning' && (
          <LightningTab
            mints={mints}
            onClose={onClose}
            onProofsReceived={onProofsReceived}
            onTransactionCreated={onTransactionCreated}
          />
        )}
      </div>
    </DialogWrapper>
  );
};

// ---------------------------------------------------------------------------
// Token tab (existing receive flow)
// ---------------------------------------------------------------------------

const TokenTab: React.FC<{
  mints: Mint[];
  p2pkPrivateKey?: string;
  /** Called when the token is from an unknown mint. Parent should show trust dialog. */
  onUnknownMint?: (mintUrl: string, amount: number, unit: string, token: string) => void;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({ mints, p2pkPrivateKey, onUnknownMint, onClose, onProofsReceived, onTransactionCreated }) => {
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReceive = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed || !isCashuToken(trimmed)) {
      toastError('Invalid token', new Error('Please paste a valid Cashu token (starting with cashuA or cashuB)'));
      return;
    }

    setLoading(true);
    const releaseLock = await acquireWalletLock('receive').catch(() => {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setLoading(false);
      return null;
    });
    if (!releaseLock) return;

    try {
      const mintUrl = extractMintUrl(trimmed);
      if (!mintUrl) throw new Error('Could not determine mint URL from token');

      // Check if the mint is already known. If not, delegate to the
      // trust dialog instead of silently auto-adding the mint.
      let knownMint = mints.find(m => m.url === mintUrl);
      if (!knownMint) {
        if (onUnknownMint) {
          let tokenAmount = 0;
          let tokenUnit = 'sat';
          try {
            // Try parsing — works reliably for V3 (cashuA), may fail for V4 (cashuB)
            // without keyset data. That's OK — we show "unknown amount" in the dialog.
            const parsed = parseToken(trimmed);
            tokenAmount = parsed.amount;
            tokenUnit = parsed.unit ?? 'sat';
          } catch {
            // V4 or unparseable — amount will be shown as "unknown" in trust dialog
          }
          onUnknownMint(mintUrl, tokenAmount, tokenUnit, trimmed);
          releaseLock();
          setLoading(false);
          return;
        }
        throw new Error(`Token is from unknown mint ${mintUrl}. Add it first in Settings.`);
      }

      // Pre-check: verify token is still spendable (NUT-07) before attempting redeem.
      // This avoids the confusing mint error when the token was already claimed.
      const spendable = await isTokenSpendable(trimmed, mintUrl);
      if (spendable === false) {
        throw new Error('This token has already been claimed and cannot be received again.');
      }

      let newProofs: Proof[];

      // Detect P2PK-locked tokens and unlock with stored key
      if (isP2pkLockedToken(trimmed) && p2pkPrivateKey) {
        newProofs = await receiveP2pkLocked(mintUrl, trimmed, p2pkPrivateKey);
      } else if (isP2pkLockedToken(trimmed)) {
        throw new Error(
          'This token is locked with P2PK. Your wallet does not have the private key to unlock it.'
        );
      } else {
        newProofs = await receiveToken(mintUrl, trimmed);
      }

      const totalReceived = newProofs.reduce((s, p) => s + p.amount, 0);
      const contextId = knownMint?.contextId ?? '';
      await onProofsReceived(contextId, newProofs, mintUrl);

      await onTransactionCreated({
        type: 'receive',
        amount: totalReceived,
        unit: knownMint?.unit ?? 'sat',
        mintUrl,
        status: 'completed',
      });

      toastSuccess('Token received', `+${totalReceived} ${knownMint?.unit ?? 'sat'}`);
      onClose();
    } catch (err) {
      toastError('Failed to receive token', err);
    } finally {
      releaseLock();
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Cashu Token</label>
        <textarea
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="cashuA... or cashuB..."
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          autoFocus
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleReceive}
          disabled={!tokenInput.trim() || loading}
          className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
          Claim Token
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lightning tab (create invoice via mint quote, show QR)
// ---------------------------------------------------------------------------

type LnStep = 'amount' | 'invoice' | 'waiting' | 'done' | 'error';

const LightningTab: React.FC<{
  mints: Mint[];
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({ mints, onClose, onProofsReceived, onTransactionCreated }) => {
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [lnStep, setLnStep] = useState<LnStep>('amount');
  const [invoice, setInvoice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const stopPollingRef = useRef<(() => void) | undefined>();
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPollingRef.current?.();
    };
  }, []);

  const handleCreateInvoice = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0) return;

    busyRef.current = true;
    setLoading(true);
    try {
      const quote = await createMintQuote(selectedMint.url, amountNum, selectedMint.unit);
      if (!mountedRef.current) return;
      setInvoice(quote.request);
      setLnStep('invoice');

      const mintUrl = selectedMint.url;
      const mintUnit = selectedMint.unit;
      const mintCtx = selectedMint.contextId;
      const quoteId = quote.quote;
      const quoteExpiry = quote.expiry ?? null;

      stopPollingRef.current = subscribeToQuote({
        mintUrl: mintUrl,
        quoteId: quoteId,
        quoteType: 'bolt11_mint_quote',
        callbacks: {
          onPaid: async () => {
            if (!mountedRef.current) return;
            setLnStep('waiting');
            try {
              const proofs = await mintTokens(mintUrl, amountNum, quoteId, mintUnit);
              if (!mountedRef.current) return;
              await onProofsReceived(mintCtx, proofs, mintUrl);
              await onTransactionCreated({
                type   : 'mint',
                amount : amountNum,
                unit   : mintUnit,
                mintUrl,
                status : 'completed',
                memo   : `Lightning deposit via ${truncateMintUrl(mintUrl)}`,
              });
              if (mountedRef.current) {
                setLnStep('done');
                toastSuccess('Received!', `+${amountNum} ${mintUnit}`);
              }
            } catch (err) {
              if (mountedRef.current) {
                setErrorMsg(err instanceof Error ? err.message : 'Failed to mint tokens');
                setLnStep('error');
              }
            }
          },
          onExpired: () => {
            if (mountedRef.current) {
              setErrorMsg('The invoice has expired. Please create a new one.');
              setLnStep('error');
            }
          },
          onIssued: () => {
            if (mountedRef.current) {
              setErrorMsg('These tokens were already minted (possibly in another session).');
              setLnStep('error');
            }
          },
          isActive: () => mountedRef.current,
        },
        checkFn: () => checkMintQuote(mintUrl, quoteId, mintUnit).then(s => ({
          state  : s.state as 'UNPAID' | 'PAID' | 'ISSUED',
          expiry : s.expiry ?? null,
        })),
        expiry: quoteExpiry,
      });
    } catch (err) {
      toastError('Failed to create invoice', err);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[nutsd] Clipboard write failed:', err);
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  if (mints.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        Add a mint first to receive via Lightning.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {lnStep === 'amount' && (
        <>
          {mints.length > 1 && (
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Mint</label>
              <select
                value={selectedMint?.url ?? ''}
                onChange={(e) => setSelectedMint(mints.find(m => m.url === e.target.value) ?? null)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                {mints.map(m => (
                  <option key={m.url} value={m.url}>
                    {m.name || truncateMintUrl(m.url)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Amount (sats)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1000"
              min="1"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />
          </div>

          <button
            onClick={handleCreateInvoice}
            disabled={!amount || loading}
            className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
            Create Invoice
          </button>
        </>
      )}

      {lnStep === 'invoice' && (
        <>
          <p className="text-xs text-muted-foreground text-center">
            Ask sender to scan this invoice for <span className="font-medium text-foreground">{amount} sats</span>
          </p>

          <QRCodeDisplay value={invoice} size={220} className="py-2" />

          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy Invoice'}
          </button>

          <button
            onClick={() => setShowRaw(!showRaw)}
            className="w-full flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDownIcon className={`h-3 w-3 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
            {showRaw ? 'Hide' : 'Show'} invoice text
          </button>
          {showRaw && (
            <div className="p-3 rounded-lg bg-background border border-border max-h-20 overflow-y-auto">
              <div className="token-string text-muted-foreground break-all">{invoice}</div>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="h-3 w-3 animate-spin" />
            Waiting for payment...
          </div>
        </>
      )}

      {lnStep === 'waiting' && (
        <div className="flex flex-col items-center py-6 gap-3">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Minting tokens...</p>
        </div>
      )}

      {lnStep === 'done' && (
        <div className="flex flex-col items-center py-6 gap-3">
          <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
          <p className="text-sm font-medium text-[var(--color-success)]">Received!</p>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      )}

      {lnStep === 'error' && (
        <div className="flex flex-col items-center py-6 gap-3">
          <div className="text-4xl text-destructive">!</div>
          <p className="text-sm font-medium text-destructive">Minting failed</p>
          <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
};
