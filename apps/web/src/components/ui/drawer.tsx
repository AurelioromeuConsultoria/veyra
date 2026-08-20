import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Painel lateral (Radix Dialog = foco/esc/aria por baixo) — modo operacional. */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-xl focus:outline-none"
          aria-describedby={undefined}
        >
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-muted-fg hover:bg-surface-2 hover:text-foreground"
              aria-label="Fechar"
            >
              <X size={16} />
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
