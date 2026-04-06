import { useState, useEffect } from 'react';
import { formatAmount } from '@/lib/utils';
import { getBtcPrice, satsToFiat, formatFiat } from '@/lib/exchange-rate';

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
  const [fiatEquiv, setFiatEquiv] = useState<string | null>(null);

  useEffect(() => {
    // Clear stale fiat immediately when inputs change.
    setFiatEquiv(null);

    if (unit !== 'sat' && unit !== 'msat') return;
    if (totalBalance <= 0) return;

    // Guard against stale async resolution: if the effect re-runs before
    // the fetch resolves, the old promise's setFiatEquiv is a no-op.
    let cancelled = false;

    getBtcPrice().then(() => {
      if (cancelled) return;
      const usd = satsToFiat(totalBalance, 'usd');
      if (usd !== null) {
        setFiatEquiv(formatFiat(usd, 'usd'));
      }
    }).catch(() => {
      // Price fetch failed — fiatEquiv stays null (already cleared above)
    });

    return () => { cancelled = true; };
  }, [totalBalance, unit]);

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
        {fiatEquiv && (
          <p className="text-xs text-muted-foreground">{fiatEquiv}</p>
        )}
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
