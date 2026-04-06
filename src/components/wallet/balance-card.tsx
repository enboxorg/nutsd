import { formatAmount } from '@/lib/utils';

interface BalanceCardProps {
  totalBalance: number;
  unit?: string;
  mintCount: number;
  /** Per-unit balance totals (for multi-unit display). */
  unitBalances?: Map<string, number>;
}

export const BalanceCard: React.FC<BalanceCardProps> = ({
  totalBalance,
  unit = 'sat',
  mintCount,
  unitBalances,
}) => {
  return (
    <div className="relative overflow-hidden rounded-xl bg-card border border-border p-6">
      {/* Subtle gradient overlay */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, transparent 60%)',
        }}
      />

      <div className="relative space-y-1">
        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          Total Balance
        </div>
        <div className="amount-display text-4xl font-bold text-foreground tracking-tight">
          {formatAmount(totalBalance, unit)}
        </div>
        <div className="text-xs text-muted-foreground">
          across {mintCount} {mintCount === 1 ? 'mint' : 'mints'}
        </div>

        {unitBalances && unitBalances.size > 1 && (
          <div className="mt-3 pt-3 border-t border-border/50 space-y-1.5">
            {Array.from(unitBalances.entries()).map(([u, bal]) => (
              <div key={u} className="flex justify-between text-xs">
                <span className="text-muted-foreground uppercase">{u}</span>
                <span className="amount-display font-medium">{formatAmount(bal, u)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
