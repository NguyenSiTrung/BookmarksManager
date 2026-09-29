import type { ReactElement, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "../../ui/components/icons";

/**
 * Left sheet over the side panel that hosts the scope content in narrow
 * mode. It is a Radix modal dialog, so Escape closes it, focus is trapped
 * while open, and focus returns to the trigger on close.
 */
export interface ScopeDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  children: ReactNode;
}

export function ScopeDrawer({
  open,
  onOpenChange,
  trigger,
  children,
}: ScopeDrawerProps): ReactElement {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,88vw)] flex-col border-r border-border bg-background shadow-pop outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:slide-in-from-left-2">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Browse
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-sm p-1 text-muted-foreground outline-hidden hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">
            Choose a folder, tag or category to show.
          </DialogPrimitive.Description>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
