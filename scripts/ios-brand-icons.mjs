#!/usr/bin/env node
/**
 * Copies the desktop's provider icons to the phone, drawing each SVG as a 96px PNG.
 *
 * `node scripts/ios-brand-icons.mjs`. The model sheet shows each provider's official icon, the same
 * files as the desktop's (`packages/ui/src/design/brand`, sources in its SOURCES.md); SwiftUI draws
 * PNG and WebP but not SVG, so the SVGs are drawn once in Chromium and committed (SPEC-0005 "MP6 定的
 * 细节 · MP6c"). Run it again when an icon there changes.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/ui/src/design/brand");
const output = join(root, "apps/ios/AtriumKit/Sources/AtriumUI/Resources/brand");
mkdirSync(output, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 96, height: 96 }, deviceScaleFactor: 1 });
  for (const file of readdirSync(source)) {
    // Atrium's own mark is not a provider's.
    if (file === "atrium.svg" || file === "SOURCES.md") continue;
    if (!file.endsWith(".svg")) {
      copyFileSync(join(source, file), join(output, file));
      continue;
    }
    // As an image in a page of its own, so the SVG's own styles apply and it fills 96px.
    const data = readFileSync(join(source, file)).toString("base64");
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img id="i" width="96" height="96" src="data:image/svg+xml;base64,${data}"></body></html>`,
    );
    await page.waitForFunction(() => document.querySelector("img")?.complete === true);
    await page.screenshot({ path: join(output, file.replace(/\.svg$/, ".png")), omitBackground: true });
  }
} finally {
  await browser.close();
}
console.log(`provider icons → ${output}`);
