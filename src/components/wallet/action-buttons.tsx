import {
  ArrowUpIcon,
  ArrowDownIcon,
  SendIcon,
  DownloadIcon,
  FileTextIcon,
} from 'lucide-react';

interface ActionButtonsProps {
  onDeposit: () => void;
  onWithdraw: () => void;
  onSend: () => void;
  onReceive: () => void;
  onRequest?: () => void;
  disabled?: boolean;
}

export const ActionButtons: React.FC<ActionButtonsProps> = ({
  onDeposit,
  onWithdraw,
  onSend,
  onReceive,
  onRequest,
  disabled,
}) => {
  const actions = [
    { label: 'Deposit', icon: ArrowDownIcon, onClick: onDeposit, color: 'text-[var(--color-success)]' },
    { label: 'Withdraw', icon: ArrowUpIcon, onClick: onWithdraw, color: 'text-[var(--color-warning)]' },
    { label: 'Send', icon: SendIcon, onClick: onSend, color: 'text-primary' },
    { label: 'Receive', icon: DownloadIcon, onClick: onReceive, color: 'text-[var(--color-info)]' },
    ...(onRequest ? [{ label: 'Request', icon: FileTextIcon, onClick: onRequest, color: 'text-[var(--color-info)]' }] : []),
  ];

  return (
    <div className={`grid gap-3 ${actions.length > 4 ? 'grid-cols-5' : 'grid-cols-4'}`}>
      {actions.map(({ label, icon: Icon, onClick, color }) => (
        <button
          key={label}
          onClick={onClick}
          disabled={disabled}
          className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-card border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className={`p-2 rounded-full bg-muted ${color}`}>
            <Icon className="h-4 w-4" />
          </div>
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
        </button>
      ))}
    </div>
  );
};
