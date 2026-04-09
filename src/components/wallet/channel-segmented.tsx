/**
 * Generic segmented control primitive.
 *
 * Used by the unified Receive dialog to switch between channels
 * (Lightning / Cashu / Address), but kept generic so it can be reused
 * anywhere a small set of exclusive options needs a pill-style switch.
 *
 * Visual treatment matches the existing tab bar inside the current
 * ReceiveDialog (`rounded-lg bg-muted p-0.5` pill-in-pill style) with
 * a smooth animated thumb via a CSS transition on `left`/`width`.
 */
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Optional icon drawn left of the label. */
  icon?: LucideIcon;
  /** Accessible description (shown via title). */
  description?: string;
  disabled?: boolean;
}

export interface ChannelSegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Extra classes on the outer container. */
  className?: string;
  /** Accessible label for the whole group. */
  'aria-label'?: string;
}

export function ChannelSegmented<T extends string>({
  options,
  value,
  onChange,
  className = '',
  'aria-label': ariaLabel = 'Select option',
}: ChannelSegmentedProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Map<T, HTMLButtonElement | null>>(new Map());

  // Track the thumb position so it slides between options.
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  // Recompute thumb position whenever the active value changes or on resize.
  useEffect(() => {
    const recalc = () => {
      const btn = btnRefs.current.get(value);
      const container = containerRef.current;
      if (!btn || !container) return;
      const btnRect = btn.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setThumb({
        left  : btnRect.left - containerRect.left,
        width : btnRect.width,
      });
    };
    // Run once now, and again after the next frame to catch layout shifts.
    recalc();
    const raf = requestAnimationFrame(recalc);
    window.addEventListener('resize', recalc);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recalc);
    };
  }, [value, options]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative flex items-center rounded-full bg-muted p-1 ${className}`}
    >
      {/* Animated thumb */}
      {thumb && (
        <div
          aria-hidden="true"
          className="absolute top-1 bottom-1 rounded-full bg-background shadow-sm transition-[left,width] duration-200 ease-out"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}

      {options.map((opt) => {
        const isActive = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            ref={(el) => btnRefs.current.set(opt.value, el)}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={opt.description}
            disabled={opt.disabled}
            onClick={() => { if (!opt.disabled) onChange(opt.value); }}
            className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
              isActive
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
