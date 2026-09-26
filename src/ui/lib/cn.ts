import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui-style class combinator: joins conditional class values with
 * `clsx`, then resolves Tailwind conflicts with `tailwind-merge` (last wins),
 * so `className` overrides passed to the primitives in `src/ui/components/`
 * beat the default classes they extend.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
