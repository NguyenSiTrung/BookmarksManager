/** Shared by the injected script and the hostile-result worker boundary. */
export const PAGE_EXTRACT_LIMITS = {
  title: 300,
  description: 1000,
  siteName: 200,
  byline: 200,
  heading: 200,
  headings: 50,
  excerpt: 20_000,
} as const;

/** Bound Readability's element traversal; a too-large document is refused. */
export const READABILITY_LIMITS = {
  maxElemsToParse: 20_000,
  charThreshold: 500,
} as const;
