import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkSite } from "../../scripts/check-site.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SITE_FILES = [
  "index.html",
  "privacy/index.html",
  "styles.css",
  "404.html",
];

const roots: string[] = [];

function freshRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `check-site-${label}-`));
  roots.push(root);
  for (const rel of SITE_FILES) {
    const src = join(REPO_ROOT, "site", rel);
    const dest = join(root, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    if (existsSync(src)) writeFileSync(dest, readFileSync(src));
  }
  mkdirSync(join(root, "store"), { recursive: true });
  writeFileSync(
    join(root, "store", "privacy-policy.md"),
    readFileSync(join(REPO_ROOT, "store", "privacy-policy.md")),
  );
  return root;
}

function violationsAt(root: string) {
  return checkSite({ root }).violations;
}

function checks(v: { check: string }[]) {
  return [...new Set(v.map((x) => x.check))];
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("checkSite", () => {
  it("passes on the real site/ tree", () => {
    expect(checkSite({ root: join(REPO_ROOT, "site") }).ok).toBe(true);
  });

  it("flags a broken internal link", () => {
    const root = freshRoot("links");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('href="privacy/"', 'href="gone/"'),
    );
    expect(checks(violationsAt(root))).toContain("links");
  });

  it("flags a missing landmark", () => {
    const root = freshRoot("landmarks");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/<main[^>]*>|<\/main>/g, ""),
    );
    expect(checks(violationsAt(root))).toContain("landmarks");
  });

  it("flags missing metadata", () => {
    const root = freshRoot("meta");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/<meta name="description"[^>]*>/, ""),
    );
    expect(checks(violationsAt(root))).toContain("metadata");
  });

  it("flags a remote script", () => {
    const root = freshRoot("scripts");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "</body>",
        '<script src="https://example.com/x.js"></script></body>',
      ),
    );
    expect(checks(violationsAt(root))).toContain("remote-code");
  });

  it("flags a tracker", () => {
    const root = freshRoot("tracker");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "</body>",
        '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></body>',
      ),
    );
    const c = checks(violationsAt(root));
    expect(c).toContain("trackers");
  });

  it("flags a form", () => {
    const root = freshRoot("form");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("</body>", "<form></form></body>"),
    );
    expect(checks(violationsAt(root))).toContain("forms");
  });

  it("flags cookie use", () => {
    const root = freshRoot("cookie");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "</body>",
        "<script>document.cookie='x=1'</script></body>",
      ),
    );
    expect(checks(violationsAt(root))).toContain("cookies");
  });

  it("flags external fonts", () => {
    const root = freshRoot("fonts");
    const file = join(root, "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "</head>",
        '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"></head>',
      ),
    );
    expect(checks(violationsAt(root))).toContain("external-assets");
  });

  it("flags policy drift", () => {
    const root = freshRoot("drift");
    const file = join(root, "privacy", "index.html");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replaceAll(/Limited Use/gi, "ltd use"),
    );
    expect(checks(violationsAt(root))).toContain("policy-drift");
  });
});
