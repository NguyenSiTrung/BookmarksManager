import { useEffect, useState } from "react";
import { cn } from "../../ui/lib/cn";
import { DecisionSettings } from "./DecisionSettings";
import { DeleteAllData } from "./DeleteAllData";
import { LlmProviderSetup } from "./LlmProviderSetup";
import { ProviderSetup } from "./ProviderSetup";
import { SentLog } from "./SentLog";

/**
 * Options page shell: a header, a sticky section navigation, and one
 * scrolling column. Every section stays mounted (the nav only scrolls), so
 * in-progress form state — a typed API key, an unchecked consent box — is
 * never lost by moving around the page.
 */
const SECTIONS = [
  { id: "providers", label: "AI providers" },
  { id: "decisions", label: "Decisions" },
  { id: "activity", label: "Activity" },
  { id: "data", label: "Data" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Track which section is nearest the top of the viewport. Without
 * `IntersectionObserver` (tests, very old browsers) the nav simply keeps its
 * initial highlight; the links still work.
 */
function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>(SECTIONS[0].id);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const visible = new Set<SectionId>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id as SectionId;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // Prefer the first section, in page order, that is on screen.
        const first = SECTIONS.find((section) => visible.has(section.id));
        if (first !== undefined) setActive(first.id);
      },
      // A band across the upper part of the viewport, so a section becomes
      // active as its heading nears the top rather than when it first peeks in.
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  return active;
}

function SectionGroup(props: {
  id: SectionId;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={props.id}
      aria-labelledby={`${props.id}-group-heading`}
      className="scroll-mt-24 space-y-4 md:scroll-mt-10"
    >
      <div className="px-1">
        <p
          id={`${props.id}-group-heading`}
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {props.title}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {props.description}
        </p>
      </div>
      {props.children}
    </section>
  );
}

export function OptionsApp() {
  const active = useActiveSection();

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            Bookmarks Manager Options
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Your bookmarks stay on this device. Nothing is sent anywhere
            unless you enable a provider and consent.
          </p>
        </header>

        <div className="mt-8 flex flex-col gap-6 md:flex-row md:gap-10">
          <nav
            aria-label="Options sections"
            className="sticky top-0 z-10 -mx-4 shrink-0 border-b border-border bg-background/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 md:top-10 md:mx-0 md:w-48 md:self-start md:border-b-0 md:bg-transparent md:p-0 md:backdrop-blur-none"
          >
            <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {SECTIONS.map((section) => (
                <li key={section.id} className="shrink-0">
                  <a
                    href={`#${section.id}`}
                    aria-current={active === section.id ? "true" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-sm outline-hidden transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                      active === section.id
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                    )}
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <main className="min-w-0 flex-1 space-y-12">
            <SectionGroup
              id="providers"
              title="AI providers"
              description="Optional. Connect a provider to power suggestions, summaries and search re-ranking."
            >
              <ProviderSetup />
              <LlmProviderSetup />
            </SectionGroup>

            <SectionGroup
              id="decisions"
              title="Decisions"
              description="Decide what AI suggestions may do on their own."
            >
              <DecisionSettings />
            </SectionGroup>

            <SectionGroup
              id="activity"
              title="Activity"
              description="What has left this device, and what it cost."
            >
              <SentLog />
            </SectionGroup>

            <SectionGroup
              id="data"
              title="Data"
              description="Remove everything this extension has stored."
            >
              <DeleteAllData />
            </SectionGroup>
          </main>
        </div>
      </div>
    </div>
  );
}
