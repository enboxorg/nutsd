/**
 * Shared big-number amount input used by the unified Send/Receive modals.
 *
 * Design goals:
 *  - Looks and feels like the balance display: tabular nums, tight tracking,
 *    large font.
 *  - Unit shown as a suffix chip (not editable).
 *  - Optional "Max" button that clamps to the given max value.
 *  - Optional helper line (e.g. "Available: 1,234 sat").
 *  - Optional status line below the input for validation ("Insufficient balance").
 *  - Controlled component: parent owns the string state.
 *
 * Input mode is always integer (no decimals) because the only unit we
 * currently use is `sat`. When we support `usd`, this component will need
 * to accept decimals — not for this PR.
 */
import { forwardRef } from 'react';

import { formatAmount } from '@/lib/utils';

export interface AmountInputProps {
  /** Controlled value as a string (so empty state is representable). */
  value: string;
  /** Change handler — receives the raw string. */
  onChange: (value: string) => void;
  /** Currency unit. Shown as a suffix chip. */
  unit: string;
  /** Max value (e.g. wallet balance). Used for the Max button. */
  max?: number;
  /** Optional helper line below the input ("Available: …"). */
  helper?: string;
  /** Optional error message shown below the input in destructive color. */
  error?: string | null;
  /** Autofocus on mount. Default: true. */
  autoFocus?: boolean;
  /** Placeholder text. Default: '0'. */
  placeholder?: string;
  /** Disable the input. */
  disabled?: boolean;
  /** When true, the label says "Optional" and the input can be empty. */
  optional?: boolean;
  /** Optional ID so an external label can `htmlFor`. */
  id?: string;
  /** Extra class names for the outer wrapper. */
  className?: string;
}

export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(
  ({
    value,
    onChange,
    unit,
    max,
    helper,
    error,
    autoFocus = true,
    placeholder = '0',
    disabled = false,
    optional = false,
    id,
    className = '',
  }, ref) => {
    const showMax = typeof max === 'number' && max > 0;
    const formattedMax = showMax ? formatAmount(max, unit) : null;

    return (
      <div className={`space-y-1.5 ${className}`}>
        <div className="flex items-center justify-between px-1">
          <label
            htmlFor={id}
            className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground"
          >
            Amount{optional && <span className="normal-case tracking-normal ml-1">(optional)</span>}
          </label>
          {showMax && (
            <button
              type="button"
              onClick={() => onChange(String(max))}
              disabled={disabled}
              className="text-[10px] uppercase tracking-wider font-medium text-primary hover:opacity-80 disabled:opacity-40 transition-opacity"
            >
              Max
            </button>
          )}
        </div>

        <div
          className={`flex items-baseline gap-2 px-4 py-3 rounded-xl bg-background border transition-colors ${
            error
              ? 'border-destructive/60 focus-within:ring-2 focus-within:ring-destructive/40'
              : 'border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30'
          }`}
        >
          <input
            ref={ref}
            id={id}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={value}
            onChange={(e) => {
              // Strip everything that isn't a digit — no decimals, no negatives.
              const sanitized = e.target.value.replace(/[^0-9]/g, '');
              onChange(sanitized);
            }}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            className="amount-display flex-1 min-w-0 bg-transparent text-3xl font-bold text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          <span className="amount-display text-sm font-medium text-muted-foreground shrink-0">
            {unit}
          </span>
        </div>

        {(helper || error) && (
          <div className="flex items-center justify-between px-1 text-[11px]">
            <span className={error ? 'text-destructive' : 'text-muted-foreground'}>
              {error || helper}
            </span>
            {!error && showMax && formattedMax && (
              <span className="text-muted-foreground">Max {formattedMax}</span>
            )}
          </div>
        )}
      </div>
    );
  },
);

AmountInput.displayName = 'AmountInput';
