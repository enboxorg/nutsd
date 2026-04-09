/**
 * Shared indicator for token claim status shown in send dialogs.
 *
 * Renders different copy based on status:
 * - checking:    capability check in progress
 * - unsupported: mint does not support NUT-07
 * - pending:     polling active, waiting for claim
 * - stale:       long-running pending, offer manual recheck
 * - claimed:     handled by the parent (this component not rendered)
 */
import { InfoIcon, Loader2Icon } from 'lucide-react';
import type { ClaimStatus } from '@/hooks/use-token-claim-status';

interface ClaimStatusIndicatorProps {
  status: ClaimStatus;
  /** Manual re-check handler (for the 'stale' state). */
  onCheckNow?: () => void;
}

export const ClaimStatusIndicator: React.FC<ClaimStatusIndicatorProps> = ({ status, onCheckNow }) => {
  if (status === 'claimed') { return null; }

  if (status === 'unsupported') {
    return (
      <div className="flex items-start gap-2 text-[10px] text-muted-foreground px-1">
        <InfoIcon className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          Token created. Claim status unavailable — this mint does not support NUT-07 proof state checks.
        </span>
      </div>
    );
  }

  if (status === 'stale') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2Icon className="h-3 w-3 animate-spin" />
          Still waiting — this can take a while.
        </div>
        {onCheckNow && (
          <button
            onClick={onCheckNow}
            className="text-[10px] text-primary hover:underline"
          >
            Check again
          </button>
        )}
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="flex items-center gap-1 justify-center text-[10px] text-muted-foreground">
        <Loader2Icon className="h-3 w-3 animate-spin" />
        Waiting for recipient to claim...
      </div>
    );
  }

  // 'checking' — briefly shown before polling starts
  return (
    <div className="flex items-center gap-1 justify-center text-[10px] text-muted-foreground">
      <Loader2Icon className="h-3 w-3 animate-spin" />
      Checking mint capabilities...
    </div>
  );
};
