import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Painel lateral (Radix Dialog = foco/esc/aria por baixo) — modo operacional. */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** para onde o foco volta ao fechar (sem gatilho do Radix, ele cairia no `body`) */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/25" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-float focus:outline-none"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <Dialog.Title className="text-display-sm">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded-control p-1.5 text-muted-fg transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Fechar"
            >
              <X size={16} />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
