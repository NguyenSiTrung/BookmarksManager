import { db } from "./database";
import { createTag, listTags } from "./meta";

/**
 * One-shot starter-tag pack for a tech/dev library.
 *
 * Seeding rules (test-pinned in `tests/unit/starter-tags.test.ts`):
 * - only when the `prefs:starterTagsSeeded` flag has never been written
 * - only when the tag library is empty (never inject into an existing set)
 * - after any decision (seeded or skipped) the flag is set, so deleting the
 *   pack later never re-injects it
 *
 * Storage: Dexie `metadata` under a namespaced key, same pattern as
 * `prefs:lastFolderId` (`src/sync/last-folder.ts`). Local-only; no network.
 */

/** Namespaced `metadata` key set once the starter-pack decision is done. */
export const STARTER_TAGS_SEEDED_KEY = "prefs:starterTagsSeeded";

/**
 * The starter pack. `description` is shown to JEV as the tag's meaning in
 * the `tags` question set, so keep each one concrete.
 */
export const STARTER_TAGS: readonly { name: string; description: string }[] = [
  {
    name: "javascript",
    description: "JS language, frameworks, and runtimes",
  },
  {
    name: "typescript",
    description: "TypeScript language and typed JavaScript tooling",
  },
  {
    name: "python",
    description: "Python language, libraries, and tooling",
  },
  {
    name: "rust",
    description: "Rust language, crates, and systems programming",
  },
  {
    name: "web-dev",
    description: "HTML/CSS, browsers, and frontend engineering",
  },
  {
    name: "backend",
    description: "Server-side architecture, APIs, and databases",
  },
  {
    name: "devops",
    description: "CI/CD, containers, cloud, and infrastructure",
  },
  {
    name: "ai-ml",
    description: "Machine learning, LLMs, and AI tooling",
  },
  {
    name: "opensource",
    description: "Open-source projects, licenses, and communities",
  },
  {
    name: "career",
    description: "Jobs, interviews, and professional growth",
  },
  {
    name: "design",
    description: "UI/UX, product design, and visual craft",
  },
  {
    name: "security",
    description: "AppSec, privacy, and security engineering",
  },
  {
    name: "performance",
    description: "Profiling, optimization, and web vitals",
  },
  {
    name: "testing",
    description: "Automated testing, QA, and quality practices",
  },
  {
    name: "architecture",
    description: "System design and software architecture",
  },
  {
    name: "tooling",
    description: "Editors, CLIs, and developer tools",
  },
  {
    name: "snippet",
    description: "Code snippets, cheatsheets, and gists",
  },
  {
    name: "reading-list",
    description: "Saved to read or watch later",
  },
];

export interface SeedStarterTagsResult {
  /** True only when this call inserted the pack. */
  readonly seeded: boolean;
  /** How many tags were created (0 unless `seeded`). */
  readonly created: number;
}

/**
 * Seed {@link STARTER_TAGS} under the one-shot rules above. Total: a storage
 * failure degrades to a no-op so startup can never crash on this step.
 */
export async function seedStarterTags(): Promise<SeedStarterTagsResult> {
  try {
    const flag = await db.metadata.get(STARTER_TAGS_SEEDED_KEY);
    if (flag?.value === true) return { seeded: false, created: 0 };

    const existing = await listTags();
    if (existing.length > 0) {
      await db.metadata.put({ key: STARTER_TAGS_SEEDED_KEY, value: true });
      return { seeded: false, created: 0 };
    }

    let created = 0;
    for (const tag of STARTER_TAGS) {
      await createTag(tag.name, { description: tag.description });
      created += 1;
    }
    await db.metadata.put({ key: STARTER_TAGS_SEEDED_KEY, value: true });
    return { seeded: true, created };
  } catch {
    return { seeded: false, created: 0 };
  }
}
