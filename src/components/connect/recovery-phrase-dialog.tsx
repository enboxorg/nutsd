import { useState } from 'react';
import { CopyIcon, CheckIcon, AlertTriangleIcon } from 'lucide-react';

interface RecoveryPhraseDialogProps {
  phrase: string;
  onDone: () => void;
}

export const RecoveryPhraseDialog: React.FC<RecoveryPhraseDialogProps> = ({
  phrase,
  onDone,
}) => {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const words = phrase.split(' ');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = phrase;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-md w-full space-y-5">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Recovery Phrase</h3>
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertTriangleIcon className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-xs text-destructive">
              Write down these words and store them somewhere safe. This is the only way to recover
              your DID and data if you clear your browser storage. Anyone with this phrase can
              access your wallet and funds.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {words.map((word, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-3 py-2 bg-muted rounded-md text-sm"
            >
              <span className="text-muted-foreground text-xs w-5 text-right">{i + 1}.</span>
              <span className="font-mono">{word}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleCopy}
          className="w-full flex items-center justify-center px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          {copied ? (
            <><CheckIcon className="h-4 w-4 mr-2" /> Copied</>
          ) : (
            <><CopyIcon className="h-4 w-4 mr-2" /> Copy to clipboard</>
          )}
        </button>

        <div className="space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1 rounded border-border"
            />
            <span className="text-xs text-muted-foreground">
              I have saved my recovery phrase in a safe place
            </span>
          </label>

          <button
            className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!confirmed}
            onClick={onDone}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
