import { useState } from 'react';
import { Loader2Icon, XIcon, ServerIcon } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/utils';
import { getMintInfo, type MintInfo } from '@/cashu/wallet-ops';
import type { MintData } from '@/protocol/cashu-wallet-protocol';

interface AddMintDialogProps {
  onAdd: (data: MintData) => Promise<void>;
  onClose: () => void;
  /** Pre-fill the URL input (e.g. when redirected from the Send scanner). */
  initialUrl?: string;
}

function extractSupportedUnits(info: MintInfo): string[] {
  try {
    const nuts = (info as any).nuts ?? (info.cache as any)?.nuts ?? {};
    const nut4 = nuts['4'];
    if (nut4?.methods && Array.isArray(nut4.methods)) {
      const unitSet = new Set<string>();
      for (const method of nut4.methods) {
        if (method.unit) unitSet.add(method.unit);
      }
      if (unitSet.size > 0) return Array.from(unitSet);
    }
  } catch {
    // Expected: mint info may not have NUT-04 methods in expected format — fall back to 'sat'
  }
  return ['sat'];
}

export const AddMintDialog: React.FC<AddMintDialogProps> = ({ onAdd, onClose, initialUrl }) => {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [loading, setLoading] = useState(false);
  const [units, setUnits] = useState<string[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<string>('');
  const [mintInfo, setMintInfo] = useState<MintInfo | null>(null);
  const [normalizedUrl, setNormalizedUrl] = useState('');

  const handleAdd = async () => {
    // If unit selector is already shown, use cached info
    if (mintInfo && normalizedUrl && selectedUnit) {
      setLoading(true);
      try {
        await onAdd({
          url: normalizedUrl,
          name: mintInfo.name || undefined,
          unit: selectedUnit,
          active: true,
          info: mintInfo.cache as unknown as Record<string, unknown>,
        });
        toastSuccess('Mint added', normalizedUrl);
        onClose();
      } catch (err) {
        toastError('Failed to connect to mint', err);
      } finally {
        setLoading(false);
      }
      return;
    }

    let mintUrl = url.trim();
    if (!mintUrl) return;
    mintUrl = mintUrl.replace(/\/+$/, '');
    if (!mintUrl.startsWith('http://') && !mintUrl.startsWith('https://')) {
      mintUrl = `https://${mintUrl}`;
    }

    setLoading(true);
    try {
      const info: MintInfo = await getMintInfo(mintUrl);

      // Extract supported units from NUT-04 (mint) methods
      const availableUnits = extractSupportedUnits(info);

      if (availableUnits.length > 1 && !selectedUnit) {
        // Show unit selector
        setUnits(availableUnits);
        setSelectedUnit(availableUnits[0]);
        setMintInfo(info);
        setNormalizedUrl(mintUrl);
        setLoading(false);
        return;
      }

      const unit = selectedUnit || availableUnits[0] || 'sat';
      await onAdd({
        url: mintUrl,
        name: info.name || undefined,
        unit,
        active: true,
        info: info.cache as unknown as Record<string, unknown>,
      });
      toastSuccess('Mint added', mintUrl);
      onClose();
    } catch (err) {
      toastError('Failed to connect to mint', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ServerIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Add Mint</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Mint URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mint.example.com"
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <p className="text-xs text-muted-foreground">
            Enter the URL of a Cashu mint. The mint info will be fetched to verify connectivity.
          </p>
        </div>

        {units.length > 1 && (
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Currency Unit</label>
            <div className="flex flex-wrap gap-2">
              {units.map(u => (
                <button
                  key={u}
                  onClick={() => setSelectedUnit(u)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    selectedUnit === u
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {u.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!url.trim() || loading}
            className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
            Add Mint
          </button>
        </div>
      </div>
    </div>
  );
};
