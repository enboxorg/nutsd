import { useState } from 'react';
import { Loader2Icon, XIcon, ShieldAlertIcon, ArrowRightLeftIcon, ShieldCheckIcon } from 'lucide-react';
import { toastError, formatAmount, truncateMintUrl } from '@/lib/utils';
import { estimateCrossMintSwap, formatSwapFee, type CrossMintSwapEstimate } from '@/cashu/cross-mint-swap';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import type { Mint } from '@/hooks/use-wallet';

interface TrustMintDialogProps {
  /** The unknown mint URL from the received token. */
  mintUrl: string;
  /** Amount of the received token. */
  amount: number;
  unit: string;
  /** The user's preferred/default mint (for cross-mint swap option). */
  defaultMint?: Mint;
  /** All known mints. */
  mints: Mint[];
  onTrustAndClaim: () => void;
  onSwapToMint: (estimate: CrossMintSwapEstimate, targetMint: Mint) => void;
  onCancel: () => void;
}

export const TrustMintDialog: React.FC<TrustMintDialogProps> = ({
  mintUrl,
  amount,
  unit,
  defaultMint,
  mints,
  onTrustAndClaim,
  onSwapToMint,
  onCancel,
}) => {
  const [loading, setLoading] = useState(false);
  const [swapEstimate, setSwapEstimate] = useState<CrossMintSwapEstimate | null>(null);
  const [selectedSwapMint, setSelectedSwapMint] = useState<Mint | null>(defaultMint ?? mints[0] ?? null);

  const handleEstimateSwap = async () => {
    if (!selectedSwapMint) return;
    setLoading(true);
    try {
      const estimate = await estimateCrossMintSwap(mintUrl, selectedSwapMint.url, amount, unit);
      setSwapEstimate(estimate);
    } catch (err) {
      toastError('Failed to estimate swap', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSwap = () => {
    if (swapEstimate && selectedSwapMint) {
      onSwapToMint(swapEstimate, selectedSwapMint);
    }
  };

  return (
    <DialogWrapper open={true} onClose={onCancel} preventClose={loading}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlertIcon className="h-5 w-5 text-[var(--color-warning)]" />
            <h3 className="text-lg font-semibold">Unknown Mint</h3>
          </div>
          {!loading && (
            <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            This token {amount > 0 ? `(${formatAmount(amount, unit)})` : '(unknown amount)'} is from a mint you haven't added:
          </p>
          <div className="p-2 rounded-lg bg-background border border-border">
            <code className="text-xs font-mono break-all text-foreground">{mintUrl}</code>
          </div>
          <p className="text-xs text-muted-foreground">
            Adding an unknown mint means trusting it with your ecash. Only add mints you trust.
          </p>
        </div>

        {/* Option 1: Trust and claim */}
        <button
          onClick={onTrustAndClaim}
          className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted transition-colors text-left"
        >
          <ShieldCheckIcon className="h-5 w-5 text-[var(--color-success)] shrink-0" />
          <div>
            <div className="text-sm font-medium">Trust & Claim</div>
            <div className="text-xs text-muted-foreground">Add this mint and receive the token</div>
          </div>
        </button>

        {/* Option 2: Swap to trusted mint */}
        {mints.length > 0 && (
          <div className="space-y-2">
            {!swapEstimate ? (
              <button
                onClick={handleEstimateSwap}
                disabled={loading}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-primary/30 hover:bg-primary/5 transition-colors text-left"
              >
                <ArrowRightLeftIcon className="h-5 w-5 text-primary shrink-0" />
                <div className="flex-1">
                  <div className="text-sm font-medium">Swap to trusted mint</div>
                  <div className="text-xs text-muted-foreground">
                    Convert via Lightning to {selectedSwapMint ? truncateMintUrl(selectedSwapMint.url) : 'your mint'}
                  </div>
                </div>
                {loading && <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />}
              </button>
            ) : (
              <div className="p-3 rounded-lg border border-primary/30 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">You receive</span>
                  <span className="font-medium">{formatAmount(swapEstimate.receiveAmount, unit)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Lightning fee</span>
                  <span>{formatSwapFee(swapEstimate.lightningFee, amount, unit)}</span>
                </div>
                <button
                  onClick={handleConfirmSwap}
                  className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Confirm Swap
                </button>
              </div>
            )}

            {mints.length > 1 && !swapEstimate && (
              <select
                value={selectedSwapMint?.url ?? ''}
                onChange={(e) => setSelectedSwapMint(mints.find(m => m.url === e.target.value) ?? null)}
                className="w-full px-3 py-1.5 rounded-lg bg-background border border-border text-xs"
              >
                {mints.map(m => (
                  <option key={m.url} value={m.url}>{m.name || truncateMintUrl(m.url)}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
