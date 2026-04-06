import { useState, useEffect, useRef } from 'react';
import { Loader2Icon, XIcon, ZapIcon, CopyIcon, CheckIcon, ChevronDownIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl } from '@/lib/utils';
import { createMintQuote, checkMintQuote, mintTokens } from '@/cashu/wallet-ops';
import { subscribeToQuote } from '@/lib/mint-ws';
import { QRCodeDisplay } from '@/components/qr-code';
import type { Mint } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface DepositDialogProps {
  mints: Mint[];
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'amount' | 'invoice' | 'waiting' | 'done' | 'error';

/** Invoice display with QR code + copy button */
const InvoiceStep: React.FC<{
  amount: string;
  invoice: string;
  onCopy: () => void;
  copied: boolean;
}> = ({ amount, invoice, onCopy, copied }) => {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground text-center">
        Scan or copy this invoice to deposit <span className="font-medium text-foreground">{amount} sats</span>
      </p>

      {/* QR Code */}
      <QRCodeDisplay
        value={invoice}
        size={220}
        className="py-2"
      />

      {/* Copy button */}
      <button
        onClick={onCopy}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
      >
        {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy Invoice'}
      </button>

      {/* Collapsible raw invoice */}
      <button
        onClick={() => setShowRaw(!showRaw)}
        className="w-full flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDownIcon className={`h-3 w-3 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
        {showRaw ? 'Hide' : 'Show'} invoice text
      </button>
      {showRaw && (
        <div className="p-3 rounded-lg bg-background border border-border max-h-20 overflow-y-auto">
          <div className="token-string text-muted-foreground break-all">
            {invoice}
          </div>
        </div>
      )}

      {/* Waiting indicator */}
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="h-3 w-3 animate-spin" />
        Waiting for payment...
      </div>
    </div>
  );
};

export const DepositDialog: React.FC<DepositDialogProps> = ({
  mints,
  onClose,
  onProofsReceived,
  onTransactionCreated,
}) => {
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('amount');
  const [invoice, setInvoice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const stopPollingRef = useRef<(() => void) | undefined>();
  const busyRef = useRef(false);
  // Track whether we're still mounted
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPollingRef.current?.();
    };
  }, []);

  const handleCreateQuote = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0) return;

    busyRef.current = true;
    setLoading(true);
    try {
      const quote = await createMintQuote(selectedMint.url, amountNum, selectedMint.unit);
      if (!mountedRef.current) return;
      setInvoice(quote.request);
      setStep('invoice');

      // Capture values for the closure
      const mintUrl = selectedMint.url;
      const mintUnit = selectedMint.unit;
      const mintCtx = selectedMint.contextId;
      const quoteId = quote.quote;
      const quoteExpiry = quote.expiry ?? null;

      // Start polling for payment
      stopPollingRef.current = subscribeToQuote({
        mintUrl: mintUrl,
        quoteId: quoteId,
        quoteType: 'bolt11_mint_quote',
        callbacks: {
          onPaid: async () => {
            if (!mountedRef.current) return;
            setStep('waiting');
            try {
              const proofs = await mintTokens(mintUrl, amountNum, quoteId, mintUnit);
              if (!mountedRef.current) return;
              await onProofsReceived(mintCtx, proofs);
              await onTransactionCreated({
                type   : 'mint',
                amount : amountNum,
                unit   : mintUnit,
                mintUrl,
                status : 'completed',
                memo   : 'Lightning deposit',
              });
              if (mountedRef.current) {
                setStep('done');
                toastSuccess('Deposit complete', `${amountNum} ${mintUnit} minted`);
              }
            } catch (err) {
              if (mountedRef.current) {
                setErrorMsg(err instanceof Error ? err.message : 'Failed to mint tokens');
                setStep('error');
              }
            }
          },
          onExpired: () => {
            if (mountedRef.current) {
              setErrorMsg('The deposit invoice has expired. Please create a new one.');
              setStep('error');
            }
          },
          onIssued: () => {
            if (mountedRef.current) {
              setErrorMsg('These tokens were already minted (possibly in another session).');
              setStep('error');
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
      toastError('Failed to create deposit', err);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  const handleCopyInvoice = async () => {
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ZapIcon className="h-5 w-5 text-[var(--color-success)]" />
            <h3 className="text-lg font-semibold">Deposit</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {step === 'amount' && (
          <div className="space-y-4">
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
              onClick={handleCreateQuote}
              disabled={!amount || loading}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Create Invoice
            </button>
          </div>
        )}

        {step === 'invoice' && (
          <InvoiceStep
            amount={amount}
            invoice={invoice}
            onCopy={handleCopyInvoice}
            copied={copied}
          />
        )}

        {step === 'waiting' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Minting tokens...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
            <p className="text-sm font-medium text-[var(--color-success)]">Deposit complete!</p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
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
    </div>
  );
};
