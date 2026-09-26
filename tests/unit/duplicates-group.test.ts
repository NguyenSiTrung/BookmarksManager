import { describe, expect, it } from "vitest";
import { groupDuplicates } from "../../src/duplicates/group";

// Item factory: extra fields beyond {id, url} must pass through untouched.
const bm = (id: string, url: string) => ({ id, url, title: `t-${id}` });

describe("groupDuplicates — shapes and labels", () => {
  it("returns [] for empty input", () => {
    expect(groupDuplicates([])).toEqual([]);
  });

  it("returns [] when every URL is unique", () => {
    const groups = groupDuplicates([
      bm("a", "https://one.com/"),
      bm("b", "https://two.com/"),
      bm("c", "https://three.com/"),
    ]);
    expect(groups).toEqual([]);
  });

  it("labels two identical raw URLs as an exact group keyed by the raw URL", () => {
    const url = "https://example.com/page";
    const groups = groupDuplicates([bm("a", url), bm("b", url)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: url, kind: "exact" });
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("carries extra item fields through to the group", () => {
    const groups = groupDuplicates([
      bm("a", "https://example.com/"),
      bm("b", "https://example.com/"),
    ]);
    expect(groups[0]?.items[0]).toMatchObject({ title: "t-a" });
  });

  it("labels cross-variant duplicates as a normalized group keyed by the normalized URL", () => {
    const groups = groupDuplicates([
      bm("a", "http://www.example.com/a/"),
      bm("b", "https://example.com/a?utm_source=x"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "example.com/a", kind: "normalized" });
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("keeps group items in input order", () => {
    const groups = groupDuplicates([
      bm("z-first", "http://example.com/"),
      bm("unrelated", "https://other.com/"),
      bm("a-second", "https://example.com/"),
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual([
      "z-first",
      "a-second",
    ]);
  });
});

describe("groupDuplicates — exact/normalized overlap rule", () => {
  // Overlap rule: a normalized bucket is emitted only when its member set is
  // NOT identical to an exact group already emitted. Exact groups always
  // appear; normalized groups may still overlap them (superset case below).

  it("suppresses a normalized group that is identical to the exact group", () => {
    const groups = groupDuplicates([
      bm("a", "https://example.com/x"),
      bm("b", "https://example.com/x"),
    ]);
    // Identical URLs normalize together — emitting both kinds would report
    // the same pair twice, so only the exact group survives.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("exact");
  });

  it("emits a normalized group that overlaps an exact group's members", () => {
    const groups = groupDuplicates([
      bm("a", "https://example.com/x"),
      bm("b", "https://example.com/x"),
      bm("c", "http://example.com/x?utm_source=y"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "exact",
      key: "https://example.com/x",
    });
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ kind: "normalized", key: "example.com/x" });
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("merges two exact groups into one normalized group under the same key", () => {
    const groups = groupDuplicates([
      bm("a", "https://example.com/x"),
      bm("b", "https://example.com/x"),
      bm("c", "http://example.com/x"),
      bm("d", "http://example.com/x"),
    ]);
    expect(groups).toHaveLength(3);
    const kinds = groups.map((g) => g.kind);
    expect(kinds).toEqual(["exact", "exact", "normalized"]);
    expect(groups[2]?.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("groupDuplicates — non-http(s) and invalid URLs", () => {
  it("groups identical chrome:// URLs exactly, never normalized", () => {
    const groups = groupDuplicates([
      bm("a", "chrome://extensions/"),
      bm("b", "chrome://extensions/"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "exact",
      key: "chrome://extensions/",
    });
  });

  it("groups identical invalid URL strings exactly", () => {
    const groups = groupDuplicates([
      bm("a", "not a url"),
      bm("b", "not a url"),
      bm("c", "also not a url"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "exact", key: "not a url" });
  });

  it("does not mix a non-http URL with an http look-alike", () => {
    const groups = groupDuplicates([
      bm("a", "chrome://example.com/a"),
      bm("b", "https://example.com/a"),
    ]);
    expect(groups).toEqual([]);
  });
});

describe("groupDuplicates — singletons and ordering", () => {
  it("excludes singletons from a partially duplicated normalized bucket", () => {
    const groups = groupDuplicates([
      bm("a", "https://example.com/x"),
      bm("b", "https://example.com/x"),
      bm("lonely", "https://unique.com/x"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.id)).not.toContain("lonely");
  });

  it("orders groups kind-first, then by first-seen order within a kind", () => {
    // Insertion order is deliberately scrambled so output order proves the
    // rule: exact groups in first-seen order, then normalized groups in
    // first-seen order — NOT input order across kinds.
    const groups = groupDuplicates([
      bm("n1", "http://www.shared.com/p/"), // normalized key first-seen 1st
      bm("e1", "https://same.com/z"), // exact key first-seen 2nd
      bm("n2", "https://shared.com/p"), // completes normalized bucket
      bm("e2", "https://same.com/z"), // completes exact bucket
      bm("e3", "https://other.com/q"), // exact key first-seen 3rd
      bm("e4", "https://other.com/q"),
      bm("n3", "http://www.late.com/m?utm_source=z"),
      bm("n4", "https://late.com/m"),
    ]);
    expect(groups.map((g) => [g.kind, g.key])).toEqual([
      ["exact", "https://same.com/z"],
      ["exact", "https://other.com/q"],
      ["normalized", "shared.com/p"],
      ["normalized", "late.com/m"],
    ]);
  });

  it("is deterministic for the same input", () => {
    const input = [
      bm("a", "http://example.com/x"),
      bm("b", "https://example.com/x"),
      bm("c", "https://dup.com/"),
      bm("d", "https://dup.com/"),
    ];
    expect(groupDuplicates(input)).toEqual(groupDuplicates(input));
  });
});
