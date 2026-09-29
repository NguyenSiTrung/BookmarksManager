import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { ChevronDownIcon } from "../../ui/components/icons";
import { PRIMARY_CHIPS, moreViews } from "./scope";
import type { AiVisibility } from "./scope";
import type { SidePanelViewKind } from "./views";

/**
 * The view switcher: All / Recent / Untagged chips plus a "More" menu for
 * Duplicates, Review suggestions and Restructure. When the active view lives
 * in More, the More chip is relabelled with that view's name so the chip row
 * always says where the user is. The pending-suggestion count shows on the
 * More chip and on the Review item.
 */
export interface ViewChipsProps {
  activeKind: SidePanelViewKind;
  pendingCount: number;
  visibility: AiVisibility;
  onSelect(kind: SidePanelViewKind): void;
}

const CHIP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-border " +
  "px-2.5 py-1 text-xs outline-hidden hover:bg-row-hover " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "aria-pressed:border-transparent aria-pressed:bg-row-selected " +
  "aria-pressed:font-medium aria-pressed:text-accent-foreground " +
  "data-[active=true]:border-transparent data-[active=true]:bg-row-selected " +
  "data-[active=true]:font-medium data-[active=true]:text-accent-foreground";

export function ViewChips({
  activeKind,
  pendingCount,
  visibility,
  onSelect,
}: ViewChipsProps): ReactElement {
  const more = moreViews(visibility, activeKind);
  const activeMore = more.find((entry) => entry.kind === activeKind);
  return (
    <nav
      aria-label="Views"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
    >
      {PRIMARY_CHIPS.map(({ kind, label }) => (
        <button
          key={kind}
          type="button"
          aria-pressed={activeKind === kind}
          onClick={() => onSelect(kind)}
          className={CHIP_CLASS}
        >
          {label}
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-active={activeMore !== undefined}
            className={CHIP_CLASS}
          >
            {activeMore?.label ?? "More"}
            {pendingCount > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="rounded-sm bg-primary px-1.5 text-[10px] font-medium text-primary-foreground"
                >
                  {pendingCount}
                </span>
                <span className="sr-only">, {pendingCount} pending</span>
              </>
            )}
            <ChevronDownIcon className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {more.map(({ kind, label }) => (
            <DropdownMenuItem key={kind} onSelect={() => onSelect(kind)}>
              {label}
              {kind === "review" && pendingCount > 0 && (
                <span className="ml-auto rounded-sm bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
                  {pendingCount}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
