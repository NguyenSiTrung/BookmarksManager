import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { db } from "../../db/database";
import { CONSENT_VERSION } from "../../consent/records";
import {
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
  LLM_TEST_SCOPE,
} from "../../schemas/provider";
import { cn } from "../../ui/lib/cn";
import {
  DatabaseIcon,
  PlugIcon,
  PulseIcon,
  ShieldIcon,
} from "../../ui/components/icons";
import {
  SetupChecklist,
  type ChecklistState,
} from "./components";
import { DecisionSettings } from "./DecisionSettings";
import { DeleteAllData } from "./DeleteAllData";
import { LlmProviderSetup } from "./LlmProviderSetup";
import { PrivacyDraft } from "./PrivacyDraft";
import { ProviderSetup } from "./ProviderSetup";
import { SentLog } from "./SentLog";

/**
 * `getManifest` may be absent (tests, non-extension contexts): read the
 * version defensively so the footer simply hides rather than crash.
 */
declare const chrome: {
  runtime: { getManifest(): { version: string } };
};

function extensionVersion(): string | null {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

/**
 * Options page shell (track options_redesign_20260929): a left icon rail with
 * one item per panel and a content column that shows exactly one panel at a
 * time. Panels stay mounted — `hidden` toggles visibility — so in-progress
 * form state (a typed API key, an unchecked consent box) is never lost by
 * moving around the page. The rail collapses to a horizontal bar on narrow
 * viewports.
 */
const PANELS = [
  {
    id: "connections",
    label: "Connections",
    icon: PlugIcon,
    description:
      "Optional. Connect a provider to power suggestions, summaries and " +
      "search re-ranking.",
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: ShieldIcon,
    description: "Decide what may leave this device, and for what.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: PulseIcon,
    description: "What has left this device, and what it cost.",
  },
  {
    id: "data",
    label: "Data",
    icon: DatabaseIcon,
    description: "Remove everything this extension has stored.",
  },
] as const;

type PanelId = (typeof PANELS)[number]["id"];

function isPanelId(value: string): value is PanelId {
  return PANELS.some((panel) => panel.id === value);
}

/** The panel a `#hash` deep link names, or the default. */
function panelFromHash(hash: string): PanelId {
  const id = hash.replace(/^#/, "");
  return isPanelId(id) ? id : PANELS[0].id;
}

export function OptionsApp() {
  const [active, setActive] = useState<PanelId>(() =>
    typeof location === "undefined" ? PANELS[0].id : panelFromHash(location.hash),
  );

  // Keep the URL hash in sync so a panel is linkable/restorable.
  useEffect(() => {
    history.replaceState(null, "", `#${active}`);
  }, [active]);

  // External #hash links (e.g. options.html#permissions from another
  // surface) switch panels without a reload.
  useEffect(() => {
    const onHash = () => setActive(panelFromHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /**
   * Setup checklist state — read straight from Dexie so the strip updates
   * live as consents are granted or revoked in any panel. A missing table or
   * an empty DB degrades to "pending", never throws the render.
   */
  const consents =
    useLiveQuery(() => db.consents.toArray().catch(() => []), []) ?? [];
  const metadataRows =
    useLiveQuery(
      () =>
        db.metadata
          .where("key")
          .anyOf(["decisions:settings", "llmEscalation"])
          .toArray()
          .catch(() => []),
      [],
    ) ?? [];

  // Connected = a current `jev_test` grant at ANY origin — presets and the
  // custom provider alike — or a configured LLM provider. Origin-agnostic
  // because the checklist only asks "is some provider usable".
  const connected =
    consents.some(
      (row) =>
        row.scope === CONSENT_SCOPE &&
        row.consentVersion === CONSENT_VERSION,
    ) || consents.some((row) => row.scope === LLM_TEST_SCOPE);
  const analysisConsented = consents.some(
    (row) =>
      row.scope === DECISIONS_CONSENT_SCOPE &&
      row.consentVersion === CONSENT_VERSION,
  );
  const automationOn = metadataRows.some((row) => {
    const value = row.value as
      | { enabled?: boolean; autoApply?: Record<string, boolean> }
      | undefined;
    return (
      value?.enabled === true ||
      Object.values(value?.autoApply ?? {}).some(Boolean)
    );
  });

  const step = (done: boolean, isCurrent: boolean): ChecklistState =>
    done ? "done" : isCurrent ? "current" : "pending";

  /**
   * Cross-panel jump used by the Permissions panel's blocked controls (the
   * second-opinion switch names prerequisites that live in Connections).
   * Panels stay mounted, so the anchor exists immediately; scroll on the
   * next frame, once the panel switch has been committed.
   */
  const navigateToConnections = (anchorId?: string): void => {
    setActive("connections");
    if (anchorId === undefined) return;
    const scroll = () => {
      const node = document.getElementById(anchorId);
      if (node !== null && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scroll);
    } else {
      queueMicrotask(scroll);
    }
  };

  return (
    <div className="options-root min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col md:flex-row">
        <nav
          aria-label="Options sections"
          className={cn(
            "sticky top-0 z-10 flex shrink-0 flex-col gap-1",
            "border-b border-border bg-background/90 px-4 py-2 backdrop-blur",
            "md:top-0 md:h-dvh md:w-60 md:flex-col md:items-stretch md:gap-0",
            "md:overflow-visible md:border-r md:border-b-0 md:bg-transparent",
            "md:px-4 md:py-8 md:backdrop-blur-none",
          )}
        >
          <div className="flex items-center gap-2.5 px-2">
            <img
              src="/icon/32.png"
              alt=""
              className="size-7 rounded-md"
            />
            <div className="min-w-0">
              <h1 className="text-sm leading-tight font-semibold tracking-tight">
                Bookmarks Manager{" "}
                <span className="font-normal text-muted-foreground">
                  Options
                </span>
              </h1>
            </div>
          </div>

          <ul className="mt-2 flex gap-1 overflow-x-auto pb-1 md:mt-8 md:flex-col md:overflow-visible md:pb-0">
            {PANELS.map((panel) => {
              const Icon = panel.icon;
              const isActive = active === panel.id;
              return (
                <li key={panel.id} className="shrink-0">
                  <a
                    href={`#${panel.id}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      setActive(panel.id);
                    }}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                      "outline-hidden transition-colors duration-150",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    {panel.label}
                  </a>
                </li>
              );
            })}
          </ul>

          <p className="mt-auto hidden px-2 text-xs text-muted-foreground md:block">
            {extensionVersion() !== null && `v${extensionVersion()} · `}your
            data stays on this device
          </p>
        </nav>

        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 md:py-10">
          {PANELS.map((panel) => (
            <div
              key={panel.id}
              id={panel.id}
              hidden={active !== panel.id}
              className="space-y-8"
            >
              <header>
                <h2 className="text-xl font-semibold tracking-tight">
                  {panel.label}
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                  {panel.description}
                </p>
              </header>
              {panel.id === "connections" && (
                <>
                  <SetupChecklist
                    steps={[
                      {
                        id: "connect",
                        title: "Connect a provider",
                        description:
                          "Pick a Jev endpoint or an OpenAI-compatible LLM.",
                        state: step(connected, true),
                      },
                      {
                        id: "consent",
                        title: "Allow bookmark analysis",
                        description: "Consent per provider, in Permissions.",
                        state: step(analysisConsented, connected),
                        onGo: () => setActive("permissions"),
                      },
                      {
                        id: "automate",
                        title: "Choose automations",
                        description:
                          "Auto-apply and second opinions stay off until you opt in.",
                        state: step(
                          automationOn,
                          connected && analysisConsented,
                        ),
                        onGo: () => setActive("permissions"),
                      },
                    ]}
                  />
                  <ProviderSetup />
                  <LlmProviderSetup />
                  <PrivacyDraft />
                </>
              )}
              {panel.id === "permissions" && (
                <DecisionSettings
                  onNavigateToConnections={navigateToConnections}
                />
              )}
              {panel.id === "activity" && <SentLog />}
              {panel.id === "data" && <DeleteAllData />}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
