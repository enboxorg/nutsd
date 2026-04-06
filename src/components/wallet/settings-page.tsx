import { useState } from 'react';
import { XIcon, SettingsIcon, KeyIcon, CopyIcon, CheckIcon, LinkIcon } from 'lucide-react';
import { toastSuccess, truncateMintUrl } from '@/lib/utils';
import { ExportIdentityDialog } from '@/components/connect/export-identity-dialog';
import type { Mint, WalletPreferences } from '@/hooks/use-wallet';
import type { P2pkKeyPair } from '@/cashu/p2pk';

interface SettingsPageProps {
  did?: string;
  /** Whether the session is delegate-based (wallet-connected) vs local-only. */
  isDelegateSession?: boolean;
  mints: Mint[];
  preferences: WalletPreferences;
  p2pkKey: P2pkKeyPair | null;
  onUpdatePreferences: (prefs: WalletPreferences) => Promise<void>;
  onClose: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  did,
  isDelegateSession,
  mints,
  preferences,
  p2pkKey,
  onUpdatePreferences,
  onClose,
}) => {
  const [defaultMint, setDefaultMint] = useState(preferences.defaultMintUrl ?? '');
  // displayCurrency disabled until exchange rate layer exists
  // const [displayCurrency, setDisplayCurrency] = useState(preferences.displayCurrency ?? 'sat');
  const [copied, setCopied] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);

  const handleSave = async () => {
    await onUpdatePreferences({
      defaultMintUrl: defaultMint || undefined,
    });
    toastSuccess('Settings saved');
  };

  const handleCopy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    toastSuccess(`${label} copied`);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Default Mint */}
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Default Mint</h3>
          <select
            value={defaultMint}
            onChange={(e) => setDefaultMint(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm"
          >
            <option value="">None (use first available)</option>
            {mints.map(m => (
              <option key={m.url} value={m.url}>
                {m.name || truncateMintUrl(m.url)} ({m.unit})
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Used as the default selection in deposit, withdraw, and send dialogs.
            Also used as the target for cross-mint swaps when receiving from unknown mints.
          </p>
        </section>

        {/* Display Currency — disabled until exchange rate fetching is implemented.
            Without a real conversion layer, this would label sat balances as fiat
            amounts (e.g. showing 1000 sat as "$1,000.00"), which is misleading.
            The preference field exists in the data model for future use. */}

        {/* Identity */}
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identity</h3>
          {did && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-card border border-border">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">Your DID</div>
                <code className="text-xs font-mono break-all">{did}</code>
              </div>
              <button
                onClick={() => handleCopy(did, 'DID')}
                className="p-1.5 rounded hover:bg-muted shrink-0"
              >
                {copied === 'DID' ? <CheckIcon className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </div>
          )}
          {p2pkKey && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-card border border-border">
              <KeyIcon className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">P2PK Public Key</div>
                <code className="text-xs font-mono break-all">{p2pkKey.publicKey}</code>
              </div>
              <button
                onClick={() => handleCopy(p2pkKey.publicKey, 'P2PK key')}
                className="p-1.5 rounded hover:bg-muted shrink-0"
              >
                {copied === 'P2PK key' ? <CheckIcon className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </div>
          )}
        </section>

        {/* Connect Wallet — only shown for local (non-delegate) sessions */}
        {did && !isDelegateSession && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Wallet</h3>
            <button
              onClick={() => setShowExportDialog(true)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-card border border-border text-left hover:bg-muted transition-colors"
            >
              <LinkIcon className="h-4 w-4 text-primary shrink-0" />
              <div>
                <div className="text-sm font-medium">Connect Wallet</div>
                <div className="text-xs text-muted-foreground">
                  Transfer your identity to an external wallet for cross-device access
                </div>
              </div>
            </button>
          </section>
        )}

        {/* Save button */}
        <button
          onClick={handleSave}
          className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Save Settings
        </button>
      </main>

      <ExportIdentityDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
      />
    </div>
  );
};
