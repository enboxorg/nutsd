/**
 * Primary wallet actions: the two big Send / Receive buttons on the
 * home screen that open the unified dialogs.
 *
 * Replaces the 4-5 tile ActionButtons grid (Deposit / Withdraw / Send /
 * Receive / Request) with a much simpler two-button layout that matches
 * the unified-flow mental model: everything is either a Send or a Receive.
 *
 * Visual treatment:
 *  - Two equal-width tall pill buttons, side by side.
 *  - Send = primary (gold). Receive = secondary (muted, still prominent).
 *  - Large target (`py-4`) for comfortable tap targets on mobile.
 *  - Icons + labels; no dense tile grid.
 */
import { ArrowUpRightIcon, ArrowDownLeftIcon } from 'lucide-react';

interface PrimaryActionsProps {
  onSend: () => void;
  onReceive: () => void;
  disabled?: boolean;
}

export const PrimaryActions: React.FC<PrimaryActionsProps> = ({
  onSend,
  onReceive,
  disabled,
}) => {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        onClick={onSend}
        disabled={disabled}
        className="group flex items-center justify-center gap-2 px-4 py-4 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold shadow-sm hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ArrowUpRightIcon className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        Send
      </button>
      <button
        onClick={onReceive}
        disabled={disabled}
        className="group flex items-center justify-center gap-2 px-4 py-4 rounded-2xl bg-card border border-border text-foreground text-sm font-semibold shadow-sm hover:bg-muted active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ArrowDownLeftIcon className="h-4 w-4 transition-transform group-hover:translate-y-0.5 group-hover:-translate-x-0.5" />
        Receive
      </button>
    </div>
  );
};
