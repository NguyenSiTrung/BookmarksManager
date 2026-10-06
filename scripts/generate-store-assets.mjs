#!/usr/bin/env node
/**
 * generate-store-assets.mjs — render store + extension icons from committed
 * sources through Playwright. No third-party logos; every PNG regenerates
 * deterministically from store/assets/source/*.
 *
 *   node scripts/generate-store-assets.mjs
 *
 * Outputs:
 *   public/icon/{16,32,48,128}.png   — manifest icons
 *   store/assets/icon-128.png        — store listing icon
 *   store/assets/promo-440x280.png   — small promo tile
 *   store/assets/marquee-1400x560.png — marquee promo tile (optional slot)
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "store", "assets", "source");

const ICON_SIZES = [16, 32, 48, 128];

async function main() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    const svg = readFileSync(join(SRC, "icon.svg"), "utf8");

    for (const size of ICON_SIZES) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!DOCTYPE html><html><body style="margin:0">${svg.replace(
          'viewBox="0 0 128 128"',
          `viewBox="0 0 128 128" width="${size}" height="${size}"`,
        )}</body></html>`,
      );
      const shot = await page.screenshot({ omitBackground: false });
      const out = join(ROOT, "public", "icon", `${size}.png`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, shot);
      console.log(`wrote public/icon/${size}.png (${shot.length} bytes)`);
    }

    const icon128 = join(ROOT, "public", "icon", "128.png");
    const storeIcon = join(ROOT, "store", "assets", "icon-128.png");
    mkdirSync(dirname(storeIcon), { recursive: true });
    copyFileSync(icon128, storeIcon);
    console.log("wrote store/assets/icon-128.png");

    await page.setViewportSize({ width: 440, height: 280 });
    await page.goto(pathToFileURL(join(SRC, "promo.html")).href);
    const promo = await page.screenshot({ omitBackground: false });
    const promoOut = join(ROOT, "store", "assets", "promo-440x280.png");
    writeFileSync(promoOut, promo);
    console.log(`wrote store/assets/promo-440x280.png (${promo.length} bytes)`);

    await page.setViewportSize({ width: 1400, height: 560 });
    await page.goto(pathToFileURL(join(SRC, "marquee.html")).href);
    const marquee = await page.screenshot({ omitBackground: false });
    const marqueeOut = join(ROOT, "store", "assets", "marquee-1400x560.png");
    writeFileSync(marqueeOut, marquee);
    console.log(`wrote store/assets/marquee-1400x560.png (${marquee.length} bytes)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
