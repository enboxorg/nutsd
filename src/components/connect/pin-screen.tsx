import { useState, useRef, useEffect } from 'react';
import { LockIcon, ShieldCheckIcon, AlertCircleIcon } from 'lucide-react';
import { brand } from '@/lib/brand';

interface PinScreenProps {
  /** 'unlock' for returning users, 'setup' for first-time PIN creation. */
  mode: 'unlock' | 'setup';
  /** Called with the PIN when the user submits. Returns true if accepted. */
  onSubmit: (pin: string) => Promise<boolean>;
}

const PIN_LENGTH = 6;

/**
 * PIN entry screen — used for both initial setup and unlock.
 *
 * - Setup mode: enter PIN, then confirm it.
 * - Unlock mode: enter PIN, verify against stored hash.
 *
 * Designed for future extraction to @enbox/react.
 */
export const PinScreen: React.FC<PinScreenProps> = ({ mode, onSubmit }) => {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  const handlePinChange = (value: string) => {
    const cleaned = value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setError('');
    if (step === 'confirm') {
      setConfirmPin(cleaned);
    } else {
      setPin(cleaned);
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting) { return; }

    if (mode === 'setup') {
      if (step === 'enter') {
        if (pin.length !== PIN_LENGTH) { return; }
        setStep('confirm');
        setConfirmPin('');
        return;
      }
      // Confirm step
      if (confirmPin !== pin) {
        setError('PINs do not match. Try again.');
        setConfirmPin('');
        return;
      }
    }

    const finalPin = mode === 'setup' ? pin : pin;
    if (finalPin.length !== PIN_LENGTH) { return; }

    setIsSubmitting(true);
    try {
      const ok = await onSubmit(finalPin);
      if (!ok) {
        setError('Incorrect PIN. Try again.');
        setPin('');
        setConfirmPin('');
        setStep('enter');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { handleSubmit(); }
  };

  const currentValue = step === 'confirm' ? confirmPin : pin;
  const isFull = currentValue.length === PIN_LENGTH;

  return (
    <div className="flex-1 flex items-center justify-center bg-background p-8">
      <div className="max-w-xs w-full text-center space-y-8">
        {/* Logo */}
        <div className="space-y-3">
          <div className="text-4xl font-bold tracking-tighter">
            {brand.baseName}<span className="text-primary">{brand.accentLetter}</span>
          </div>
          <div className="flex justify-center">
            {mode === 'setup'
              ? <ShieldCheckIcon className="h-8 w-8 text-primary" />
              : <LockIcon className="h-8 w-8 text-primary" />
            }
          </div>
        </div>

        {/* Title */}
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {mode === 'setup'
              ? (step === 'confirm' ? 'Confirm PIN' : 'Set a PIN')
              : 'Enter PIN'
            }
          </h2>
          <p className="text-xs text-muted-foreground">
            {mode === 'setup'
              ? (step === 'confirm'
                  ? 'Re-enter your PIN to confirm'
                  : 'Choose a 6-digit PIN to lock your wallet')
              : 'Enter your 6-digit PIN to unlock'
            }
          </p>
        </div>

        {/* PIN dots */}
        <div className="flex justify-center gap-3">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <div
              key={i}
              className={`w-3.5 h-3.5 rounded-full border-2 transition-all duration-150 ${
                i < currentValue.length
                  ? 'bg-primary border-primary scale-110'
                  : 'border-border'
              }`}
            />
          ))}
        </div>

        {/* Hidden input — captures keyboard input */}
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={currentValue}
          onChange={(e) => handlePinChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="sr-only"
          aria-label="PIN input"
        />

        {/* Error */}
        {error && (
          <div className="flex items-center justify-center gap-2 text-red-400">
            <AlertCircleIcon className="h-4 w-4" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!isFull || isSubmitting}
          className="w-full px-6 py-3 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {isSubmitting
            ? 'Verifying...'
            : mode === 'setup'
              ? (step === 'confirm' ? 'Set PIN' : 'Next')
              : 'Unlock'
          }
        </button>

        {/* Tap-to-focus hint */}
        <button
          onClick={() => inputRef.current?.focus()}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Tap here if the keyboard is not showing
        </button>
      </div>
    </div>
  );
};
