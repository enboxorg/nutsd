import * as Dialog from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

interface DialogWrapperProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Accessible title for screen readers. */
  title?: string;
  /** Max width class (default: 'max-w-sm') */
  maxWidth?: string;
  /**
   * When true, prevents Escape key and all close paths.
   *
   * Use this during in-flight financial operations (melt, swap, mint)
   * where closing the dialog would strand funds. The dialog cannot be
   * dismissed until the operation completes or fails.
   */
  preventClose?: boolean;
}

/**
 * Reusable dialog wrapper using Radix Dialog primitives.
 *
 * Provides: focus trapping, ARIA role="dialog".
 * Escape to close: only when `preventClose` is false.
 * Backdrop click: always prevented (too easy to accidentally dismiss).
 */
export const DialogWrapper: React.FC<DialogWrapperProps> = ({
  open,
  onClose,
  children,
  title = 'Dialog',
  maxWidth = 'max-w-sm',
  preventClose = false,
}) => {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !preventClose) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] ${maxWidth} bg-card border border-border p-6 rounded-xl shadow-xl focus:outline-none`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => { if (preventClose) e.preventDefault(); }}
          aria-describedby={undefined}
        >
          <VisuallyHidden>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
