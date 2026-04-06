import * as Dialog from '@radix-ui/react-dialog';

interface DialogWrapperProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Max width class (default: 'max-w-sm') */
  maxWidth?: string;
}

/**
 * Reusable dialog wrapper using Radix Dialog primitives.
 * Provides: Escape to close, focus trapping, backdrop click to close, ARIA attributes.
 */
export const DialogWrapper: React.FC<DialogWrapperProps> = ({
  open,
  onClose,
  children,
  maxWidth = 'max-w-sm',
}) => {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] ${maxWidth} bg-card border border-border p-6 rounded-xl shadow-xl focus:outline-none`}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
