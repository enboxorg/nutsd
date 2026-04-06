import { useState, useMemo } from 'react';
import { XIcon, FileTextIcon } from 'lucide-react';
import { formatAmount, truncateMintUrl } from '@/lib/utils';
import { encodePaymentRequest } from '@/cashu/payment-request';
import { QRCodeDisplay } from '@/components/qr-code';
import type { Mint } from '@/hooks/use-wallet';

interface CreateRequestDialogProps {
  mints: Mint[];
  onClose: () => void;
}

export const CreateRequestDialog: React.FC<CreateRequestDialogProps> = ({ mints, onClose }) => {
  const [amount, setAmount] = useState('');
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [memo, setMemo] = useState('');
  const [created, setCreated] = useState(false);

  const encodedRequest = useMemo(() => {
    if (!created) return '';
    const amountNum = parseInt(amount) || 0;
    return encodePaymentRequest({
      amount: amountNum,
      unit: selectedMint?.unit ?? 'sat',
      mints: selectedMint ? [selectedMint.url] : mints.map(m => m.url),
      description: memo.trim() || undefined,
    });
  }, [created, amount, selectedMint, memo, mints]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><FileTextIcon className="h-5 w-5 text-primary" /><h3 className="text-lg font-semibold">Payment Request</h3></div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><XIcon className="h-4 w-4" /></button>
        </div>

        {!created ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Amount (0 = any)</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" min="0"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50" autoFocus />
            </div>
            {mints.length > 1 && (
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Accepted mint</label>
                <select
                  value={selectedMint ? `${selectedMint.url}|${selectedMint.unit}` : ''}
                  onChange={e => {
                    const [url, unit] = e.target.value.split('|');
                    setSelectedMint(mints.find(m => m.url === url && m.unit === unit) ?? null);
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
                >
                  {mints.map(m => (
                    <option key={`${m.url}|${m.unit}`} value={`${m.url}|${m.unit}`}>
                      {m.name || truncateMintUrl(m.url)} ({m.unit})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Memo (optional)</label>
              <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="What's this for?"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <button onClick={() => setCreated(true)} className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">
              Create Request
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center"><QRCodeDisplay value={encodedRequest} size={200} /></div>
            <div className="text-center space-y-1">
              {parseInt(amount) > 0 && <p className="text-lg font-semibold">{formatAmount(parseInt(amount), selectedMint?.unit)}</p>}
              {memo && <p className="text-xs text-muted-foreground">{memo}</p>}
            </div>
            <p className="text-[10px] text-muted-foreground text-center break-all font-mono">{encodedRequest}</p>
            <button onClick={onClose} className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium">Done</button>
          </div>
        )}
      </div>
    </div>
  );
};
