import { PlusIcon, ServerIcon } from 'lucide-react';
import { truncateMintUrl, formatAmount } from '@/lib/utils';
import type { Mint } from '@/hooks/use-wallet';

interface MintListCardProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  mintHealth?: Map<string, boolean>;
  onAddMint: () => void;
  onSelectMint: (mint: Mint) => void;
}

export const MintListCard: React.FC<MintListCardProps> = ({
  mints,
  mintBalances,
  mintHealth,
  onAddMint,
  onSelectMint,
}) => {
  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Mints</h3>
        <button
          onClick={onAddMint}
          className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      {mints.length === 0 ? (
        <div className="p-4 text-center">
          <ServerIcon className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">
            No mints added yet. Add a Cashu mint to get started.
          </p>
          <button
            onClick={onAddMint}
            className="mt-3 px-4 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
          >
            Add Mint
          </button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {mints.map((mint) => {
            const balance = mintBalances.get(mint.url) ?? 0;
            return (
              <button
                key={mint.id}
                onClick={() => onSelectMint(mint)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-1.5 rounded-md bg-primary/10 text-primary shrink-0">
                    <ServerIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5">
                      {mint.name || truncateMintUrl(mint.url)}
                      <div className={`h-2 w-2 rounded-full shrink-0 ${
                        mintHealth?.get(mint.contextId) === true ? 'bg-[var(--color-success)]' :
                        mintHealth?.get(mint.contextId) === false ? 'bg-destructive' :
                        'bg-muted-foreground/30'
                      }`} title={mintHealth?.get(mint.contextId) === true ? 'Online' : mintHealth?.get(mint.contextId) === false ? 'Offline' : 'Checking...'} />
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {mint.url}
                    </div>
                  </div>
                </div>
                <div className="amount-display text-sm font-medium text-foreground shrink-0 ml-3">
                  {formatAmount(balance, mint.unit)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
