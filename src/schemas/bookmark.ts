import { z } from "./z";

// Field shapes follow PROJECT_PLAN.md §7 "Data Model (Zod)" verbatim.

export const Category = z.enum([
  "article",
  "paper",
  "course",
  "docs",
  "tool",
  "video",
  "repo",
  "reference",
  "shopping",
  "social",
  "other",
]);

export const Bookmark = z.object({
  id: z.string(), // Chrome bookmark node id
  url: z.url(),
  title: z.string().min(1).max(500),
  folderId: z.string(),
  tags: z.array(z.string()).default([]),
  category: Category.optional(),
  notes: z.string().max(10_000).optional(),
  summary: z.string().max(2_000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  health: z
    .object({
      status: z.enum(["unknown", "ok", "redirect", "dead", "soft_dead", "error"]),
      httpCode: z.number().int().optional(),
      finalUrl: z.url().optional(),
      checkedAt: z.iso.datetime().optional(),
    })
    .default({ status: "unknown" }),
  schemaVersion: z.literal(1),
});

export const Tag = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300).optional(), // shown to Jev as the option's meaning
  color: z.string().optional(),
});

export type Category = z.infer<typeof Category>;
export type Bookmark = z.infer<typeof Bookmark>;
export type Tag = z.infer<typeof Tag>;
