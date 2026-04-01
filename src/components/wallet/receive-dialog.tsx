import { useState } from 'react';
import { Loader2Icon, XIcon, DownloadIcon } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/utils';
import { receiveToken } from '@/cashu/wallet-ops';
import { extractMintUrl, isCashuToken } from '@/cashu/token-utils';
import type { Mint } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface ReceiveDialogProps {
  mints: Mint[];
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<void>;
}

export const ReceiveDialog: React.FC<ReceiveDialogProps> = ({
  mints,
  onClose,
  onProofsReceived,
  onTransactionCreated,
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReceive = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed || !isCashuToken(trimmed)) {
      toastError('Invalid token', new Error('Please paste a valid Cashu token (starting with cashuA or cashuB)'));
      return;
    }

    setLoading(true);
    try {
      // Extract mint URL without full decoding (avoids V4 keyset mapping issue)
      const mintUrl = extractMintUrl(trimmed);
      if (!mintUrl) {
        throw new Error('Could not determine mint URL from token');
      }

      const knownMint = mints.find(m => m.url === mintUrl);

      // Receive: wallet.receive() handles V4 keyset mapping internally
      // because getWallet() calls loadMint() which fetches the mint's keysets
      const newProofs = await receiveToken(mintUrl, trimmed);
      const totalReceived = newProofs.reduce((s, p) => s + p.amount, 0);

      // Store proofs (auto-adds mint if unknown)
      const contextId = knownMint?.contextId ?? '';
      await onProofsReceived(contextId, newProofs, mintUrl);

      await onTransactionCreated({
        type: 'receive',
        amount: totalReceived,
        unit: 'sat',
        mintUrl,
        status: 'completed',
        cashuToken: trimmed,
      });

      toastSuccess('Token received', `+${totalReceived} sat`);
      onClose();
    } catch (err) {
      toastError('Failed to receive token', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DownloadIcon className="h-5 w-5 text-[var(--color-info)]" />
            <h3 className="text-lg font-semibold">Receive</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

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
          <p className="text-xs text-muted-foreground">
            Paste a Cashu token to claim it. The token will be swapped with the mint for fresh proofs.
          </p>
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
    </div>
  );
};
