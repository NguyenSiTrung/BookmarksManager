import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { SettingsIcon } from "../../ui/components/settings-icon";
import type { AiVisibility } from "./scope";

/**
 * Top of the side panel: the search input (passed as a slot), the Tools menu
 * and Settings. There is no visible title — Chrome's panel header already
 * names the extension — but a screen-reader-only `<h1>` keeps the landmark.
 */
export type ToolsAction =
  | "import"
  | "export"
  | "manage-tags"
  | "scan"
  | "set-up-ai";

export interface TopBarProps {
  search: ReactNode;
  visibility: AiVisibility;
  onTools(action: ToolsAction): void;
  onOpenSettings(): void;
}

const ICON_BUTTON_CLASS =
  "shrink-0 rounded-sm p-1 text-muted-foreground outline-hidden " +
  "hover:bg-row-hover hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring";

export function TopBar({
  search,
  visibility,
  onTools,
  onOpenSettings,
}: TopBarProps): ReactElement {
  return (
    <header className="shrink-0 border-b border-border px-3 py-2">
      <h1 className="sr-only">Bookmarks Manager</h1>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{search}</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Tools"
              title="Tools"
              className={`${ICON_BUTTON_CLASS} px-2 text-base leading-none`}
            >
              ⋯
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onTools("import")}>
              Import…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTools("export")}>
              Export…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTools("manage-tags")}>
              Manage tags…
            </DropdownMenuItem>
            {visibility.showScan && (
              <DropdownMenuItem onSelect={() => onTools("scan")}>
                Scan library…
              </DropdownMenuItem>
            )}
            {visibility.showSetUpAi && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onTools("set-up-ai")}>
                  Set up AI…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
          className={ICON_BUTTON_CLASS}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
