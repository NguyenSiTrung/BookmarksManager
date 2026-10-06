import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";

import {
  checkStore,
  type CheckStoreViolation,
} from "../../scripts/check-store.mjs";

/**
 * Red-side coverage for the release-strict store checker (Phase 6 Task 2).
 * Each fixture copies the repo's real release surfaces into a temp root —
 * store docs, consent/release-policy sources, package.json, wxt.config.ts,
 * the built manifest — then synthesizes the asset PNGs and the release
 * record so a good fixture passes end to end. Violation tests mutate one
 * thing and assert the specific check reports it.
 */

const REPO = resolve(__dirname, "..", "..");
const RELEASE = "1.0.0";

/**
 * The good fixture copies the BUILT manifest, so a clean checkout needs one
 * build first — `npm run build` is cheap (~1 s) and runs only when
 * `.output/chrome-mv3/manifest.json` is absent.
 */
beforeAll(() => {
  if (!existsSync(join(REPO, ".output", "chrome-mv3", "manifest.json"))) {
    execFileSync("npm", ["run", "build", "--silent"], {
      cwd: REPO,
      stdio: "inherit",
    });
  }
});

/** A PNG whose IHDR reports w×h — enough for the checker's dimension read. */
function pngWithSize(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0); // \x89PNG signature word
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

/**
 * Build a passing release tree under `root` from the repo's real files,
 * overriding versions to RELEASE and synthesizing assets + the record.
 */
export function buildGoodFixture(root: string): void {
  mkdirSync(root, { recursive: true });
  for (const name of [
    "permissions.md",
    "privacy-policy.md",
    "privacy-practices.md",
    "genai-disclosure.md",
    "listing.md",
    "reviewer-notes.md",
  ]) {
    cpSync(join(REPO, "store", name), join(root, "store", name), {
      recursive: false,
    });
  }
  mkdirSync(join(root, "store", "evals"), { recursive: true });
  cpSync(
    join(REPO, "store", "evals", "jev-1.13-baseline.md"),
    join(root, "store", "evals", "jev-1.13-baseline.md"),
  );
  for (const rel of [
    "src/consent/disclosure.ts",
    "src/decisions/release-policy.ts",
    "src/schemas/provider.ts",
    "src/net/provider-info.ts",
  ]) {
    mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), {
      recursive: true,
    });
    cpSync(join(REPO, rel), join(root, rel));
  }

  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  pkg.version = RELEASE;
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
  const wxt = readFileSync(join(REPO, "wxt.config.ts"), "utf8").replace(
    /version:\s*"[^"]+"/,
    `version: "${RELEASE}"`,
  );
  writeFileSync(join(root, "wxt.config.ts"), wxt);

  // The built manifest — produced by `npm run build` in the repo.
  const manifestPath = join(REPO, ".output", "chrome-mv3", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = RELEASE;
  mkdirSync(join(root, ".output", "chrome-mv3"), { recursive: true });
  writeFileSync(
    join(root, ".output", "chrome-mv3", "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  const assets = join(root, "store", "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "icon-128.png"), pngWithSize(128, 128));
  writeFileSync(join(assets, "promo-440x280.png"), pngWithSize(440, 280));
  writeFileSync(
    join(assets, "screenshot-sidepanel.png"),
    pngWithSize(1280, 800),
  );

  mkdirSync(join(root, "store", "releases"), { recursive: true });
  writeFileSync(
    join(root, "store", "releases", `${RELEASE}.json`),
    JSON.stringify(
      {
        version: RELEASE,
        commit: "0".repeat(40),
        generatedAt: "2026-09-28T00:00:00.000Z",
        zip: {
          file: "bookmarks-manager-1.0.0-chrome.zip",
          bytes: 123456,
          sha256: "0".repeat(64),
        },
      },
      null,
      2,
    ),
  );
}

function violationsAt(root: string, release = RELEASE) {
  return checkStore({ root, release }).violations;
}

function publicViolationsAt(root: string, release = RELEASE) {
  return checkStore({ root, release, channel: "public" }).violations;
}

/**
 * Public-channel extras on top of the good fixture: the full five-screenshot
 * set and the marquee tile. No promo video — the public listing does not
 * require one.
 */
function makePublicReady(root: string): void {
  const assets = join(root, "store", "assets");
  for (const n of [2, 3, 4, 5]) {
    writeFileSync(
      join(assets, `screenshot-extra-${n}.png`),
      pngWithSize(1280, 800),
    );
  }
  writeFileSync(join(assets, "marquee-1400x560.png"), pngWithSize(1400, 560));
}

function checks(violations: { check: string }[]): Set<string> {
  return new Set(violations.map((v) => v.check));
}

function freshRoot(name: string): string {
  const root = join(tmpdir(), `check-store-${name}-${process.pid}`);
  buildGoodFixture(root);
  return root;
}

describe("checkStore", () => {
  it("passes a complete release tree", () => {
    const root = freshRoot("good");
    expect(violationsAt(root)).toEqual([]);
  });

  it("flags unfinished markers in store docs", () => {
    const root = freshRoot("markers");
    const file = join(root, "store", "listing.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        "\n- Homepage: _release prerequisite_\n",
    );
    const v = violationsAt(root);
    expect(checks(v)).toContain("unfinished-marker");
    expect(
      v.find((x: CheckStoreViolation) => x.check === "unfinished-marker")
        ?.file,
    ).toBe("store/listing.md");
  });

  it("flags a missing publisher identity and contact", () => {
    const root = freshRoot("publisher");
    const file = join(root, "store", "privacy-policy.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "**NguyenSiTrung**",
        "_release prerequisite_",
      ),
    );
    expect(checks(violationsAt(root))).toContain("publisher-contact");
  });

  it("flags missing public URLs in the listing", () => {
    const root = freshRoot("urls");
    const file = join(root, "store", "listing.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replaceAll(
        "https://nguyensitrung.github.io/BookmarksManager/privacy/",
        "",
      ),
    );
    expect(checks(violationsAt(root))).toContain("public-urls");
  });

  it("flags version disagreement between package.json and release", () => {
    const root = freshRoot("version");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.version = "0.1.0";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(checks(violationsAt(root))).toContain("version");
  });

  it("flags undocumented permissions (manifest vs permissions.md drift)", () => {
    const root = freshRoot("perms");
    const path = join(root, ".output", "chrome-mv3", "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.permissions = [...manifest.permissions, "history"];
    writeFileSync(path, JSON.stringify(manifest));
    expect(checks(violationsAt(root))).toContain("permissions");
  });

  it("flags absent Limited Use text", () => {
    const root = freshRoot("limited-use");
    const file = join(root, "store", "privacy-policy.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /## Limited Use statement[\s\S]*?\n## /,
        "## ",
      ),
    );
    expect(checks(violationsAt(root))).toContain("limited-use");
  });

  it("flags missing custom-provider capability text", () => {
    const root = freshRoot("custom");
    const file = join(root, "store", "permissions.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replaceAll(/capabilit/gi, "capXbility"),
    );
    expect(checks(violationsAt(root))).toContain("custom-provider");
  });

  it("flags missing reviewer walkthrough content", () => {
    const root = freshRoot("reviewer");
    const file = join(root, "store", "reviewer-notes.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "## Testing without an API key",
        "## ",
      ),
    );
    expect(checks(violationsAt(root))).toContain("reviewer-notes");
  });

  it("flags a missing icon asset", () => {
    const root = freshRoot("no-icon");
    execFileSync("rm", ["-f", join(root, "store", "assets", "icon-128.png")]);
    expect(checks(violationsAt(root))).toContain("assets");
  });

  it("flags a wrong-size screenshot asset", () => {
    const root = freshRoot("bad-size");
    writeFileSync(
      join(root, "store", "assets", "screenshot-sidepanel.png"),
      pngWithSize(900, 600),
    );
    expect(checks(violationsAt(root))).toContain("assets");
  });

  it("keeps public-media checks out of the trusted-tester channel", () => {
    const root = freshRoot("trusted-no-public-media");
    const v = checks(violationsAt(root));
    expect(v).not.toContain("public-screenshots");
    expect(v).not.toContain("public-marquee");
  });

  it("flags missing public listing media on the public channel", () => {
    const root = freshRoot("public-media-missing");
    const v = checks(publicViolationsAt(root));
    expect(v).toContain("public-screenshots");
    expect(v).toContain("public-marquee");
  });

  it("passes the public channel with full listing media", () => {
    const root = freshRoot("public-complete");
    makePublicReady(root);
    expect(publicViolationsAt(root)).toEqual([]);
  });

  it("flags a wrong-size marquee tile on the public channel", () => {
    const root = freshRoot("public-marquee-bad");
    makePublicReady(root);
    writeFileSync(
      join(root, "store", "assets", "marquee-1400x560.png"),
      pngWithSize(1400, 561),
    );
    expect(checks(publicViolationsAt(root))).toContain("public-marquee");
  });

  it("flags moving release model defaults", () => {
    const root = freshRoot("alias");
    const file = join(root, "src", "schemas", "provider.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        'typesafe: RELEASE_JEV_MODELS.typesafe.request,',
        'typesafe: "jev-latest",',
      ),
    );
    expect(checks(violationsAt(root))).toContain("release-models");
  });

  it("flags missing eval evidence and release record", () => {
    const root = freshRoot("evidence");
    execFileSync("rm", [
      "-f",
      join(root, "store", "evals", "jev-1.13-baseline.md"),
    ]);
    execFileSync("rm", [
      "-f",
      join(root, "store", "releases", `${RELEASE}.json`),
    ]);
    const v = checks(violationsAt(root));
    expect(v).toContain("eval-evidence");
    expect(v).toContain("release-record");
  });

  it("flags a release record whose version disagrees", () => {
    const root = freshRoot("record");
    const path = join(root, "store", "releases", `${RELEASE}.json`);
    const rec = JSON.parse(readFileSync(path, "utf8"));
    rec.version = "0.9.0";
    writeFileSync(path, JSON.stringify(rec));
    expect(checks(violationsAt(root))).toContain("release-record");
  });
});

describe("the real repo on the current tree", () => {
  it("reports only the still-missing release artifacts", () => {
    if (!existsSync(join(REPO, ".output", "chrome-mv3", "manifest.json"))) {
      return; // build first; CI builds before this check runs
    }
    const v = violationsAt(REPO);
    const c = checks(v);
    // The version is bumped and assets exist; until the release record lands
    // the only remaining violation may be "release-record" (empty once the
    // record is written — everything else must already be clean).
    expect(c.size === 0 || (c.size === 1 && c.has("release-record"))).toBe(
      true,
    );
    expect(c).not.toContain("unfinished-marker");
    expect(c).not.toContain("publisher-contact");
    expect(c).not.toContain("public-urls");
    expect(c).not.toContain("permissions");
    expect(c).not.toContain("limited-use");
    expect(c).not.toContain("custom-provider");
    expect(c).not.toContain("reviewer-notes");
    expect(c).not.toContain("release-models");
    expect(c).not.toContain("eval-evidence");
    expect(c).not.toContain("version");
    expect(c).not.toContain("assets");
  });
});
