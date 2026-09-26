import type { SearchSourceBookmark } from "../../src/search/index";

/**
 * Shared tag definitions for search tests, in the minimal `{ name, nameKey }`
 * shape `buildTagNameMap` consumes. Each `nameKey` satisfies TagDef's rule
 * (`nameKey === name.trim().toLowerCase()`, interior whitespace preserved).
 */
export const searchTagDefs = [
  { name: "Reading List", nameKey: "reading list" },
  { name: "TypeScript", nameKey: "typescript" },
] as const;

/**
 * Minimal `SearchSourceBookmark` builder: an id is required, everything else
 * defaults (title/url derived from the id, no ancestors, no meta fields) and
 * may be overridden. The default URL carries a `www.` host so domain
 * derivation is exercised unless the test supplies its own.
 */
export function searchSource(
  overrides: Partial<SearchSourceBookmark> & Pick<SearchSourceBookmark, "id">,
): SearchSourceBookmark {
  return {
    title: `Bookmark ${overrides.id}`,
    url: `https://www.${overrides.id}.example/`,
    ancestors: [],
    tagKeys: [],
    ...overrides,
  };
}
