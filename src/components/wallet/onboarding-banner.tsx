import { PlusCircleIcon, InfoIcon } from 'lucide-react';

interface OnboardingBannerProps {
  onAddMint: () => void;
}

export const OnboardingBanner: React.FC<OnboardingBannerProps> = ({ onAddMint }) => {
  return (
    <div className="rounded-xl bg-primary/5 border border-primary/20 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <InfoIcon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Welcome! Let's set up your wallet.</h3>
          <p className="text-xs text-muted-foreground">
            To start using ecash, add a Cashu mint. A mint is a server that issues
            and redeems ecash tokens. You can add any mint you trust.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Suggested mints:</p>
        <div className="space-y-1.5">
          {[
            { url: 'https://mint.minibits.cash/Bitcoin', name: 'Minibits' },
            { url: 'https://mint.coinos.io', name: 'Coinos' },
            { url: 'https://testnut.cashu.space', name: 'Testnut (testing only)' },
          ].map(m => (
            <div key={m.url} className="flex items-center justify-between p-2 rounded-lg bg-background border border-border">
              <div className="min-w-0">
                <div className="text-xs font-medium">{m.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">{m.url}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onAddMint}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
      >
        <PlusCircleIcon className="h-4 w-4" />
        Add Your First Mint
      </button>
    </div>
  );
};
