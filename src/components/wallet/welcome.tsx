import { useState } from 'react';
import { Loader2Icon, ShieldIcon, RefreshCwIcon, ZapIcon } from 'lucide-react';
import { useEnbox } from '@/enbox';
import { toastError } from '@/lib/utils';
import { brand } from '@/lib/brand';

export const Welcome: React.FC = () => {
  const { isConnecting, connectWallet } = useEnbox();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectWallet();
    } catch (error) {
      const msg = (error as Error).message || '';
      // Denial / cancellation — swallow, no error toast.
      if (!msg.includes('denied') && !msg.includes('cancelled')) {
        toastError('Failed to connect wallet', error);
      }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-background p-8">
      <div className="max-w-md text-center space-y-8">
        {/* Logo / Title */}
        <div className="space-y-3">
          <div className="text-5xl font-bold tracking-tighter">
            {brand.baseName}<span className="text-primary">{brand.accentLetter}</span>
          </div>
          <p className="text-muted-foreground text-sm">
            {brand.description}
          </p>
        </div>

        {/* Features */}
        <div className="grid gap-4 text-left">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <ShieldIcon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium">Private ecash</div>
              <div className="text-xs text-muted-foreground">
                Chaumian blind signatures make your transactions unlinkable. Your wallet, your privacy.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <RefreshCwIcon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium">Encrypted DWN storage</div>
              <div className="text-xs text-muted-foreground">
                Proofs and transactions encrypted in your personal DWN. Not even the server can read them.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <ZapIcon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium">Multiple mints</div>
              <div className="text-xs text-muted-foreground">
                Connect to multiple Cashu mints. Deposit and withdraw via Lightning.
              </div>
            </div>
          </div>
        </div>

        {/* Connect CTA */}
        {isConnecting ? (
          <div className="text-sm text-muted-foreground animate-pulse">
            Restoring session...
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {connecting && <Loader2Icon className="animate-spin h-4 w-4" />}
            {connecting ? 'Connecting...' : 'Get Started'}
          </button>
        )}
      </div>
    </div>
  );
};
