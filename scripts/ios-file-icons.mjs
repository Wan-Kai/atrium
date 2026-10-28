#!/usr/bin/env node
/**
 * Builds the phone's file icons from the desktop's: the same material-icon-theme lookups and the
 * path data of each icon, as one JSON resource of AtriumUI.
 *
 * `node scripts/ios-file-icons.mjs [--check]`. SwiftUI cannot draw SVG, so each icon becomes its
 * view box and filled paths, which `FileIcon` draws; an icon with anything but filled paths
 * (circles, groups, gradients, transforms) is left out and the plain file icon stands in for it
 * (SPEC-0005 "MP6 定的细节 · MP6a"). `--check` fails when the committed file is out of date.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(readFileSync(join(root, "packages/ui/src/files/file-icons.json"), "utf8"));
const icons = join(root, "node_modules/material-icon-theme/icons");
const output = join(root, "apps/ios/AtriumKit/Sources/AtriumUI/Resources/file-icons.json");

/**
 * One icon's view box and paths, or `null` when it has more than filled paths.
 *
 * @remarks
 * Only `<svg>` and `<path>` elements; a path's `fill` (else the `<svg>`'s, else black), `fill-rule`
 * and `opacity` are kept, and a path filled with `none` is left out. An icon with a visible stroke is
 * not drawable: leaving the stroked parts out would draw a different icon.
 *
 * @sideEffects none
 * @param {string} svg - The icon's SVG.
 * @returns {{ box: number[], paths: { d: string, fill: string, evenOdd?: true, opacity?: number }[] } | null} The icon.
 */
function parse(svg) {
  const elements = [...svg.matchAll(/<([a-zA-Z]+)\b/g)].map((match) => match[1]);
  if (elements.some((name) => name !== "svg" && name !== "path")) return null;
  const box = /viewBox="([^"]+)"/
    .exec(svg)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box === undefined || box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
  // A path without its own fill takes the <svg>'s, black when neither says.
  const inherited = /<svg\b[^>]*?\sfill="([^"]*)"/.exec(svg)?.[1] ?? "#000";
  // Strokes are not drawn, so an icon with any would come out with parts missing.
  const strokes = [...svg.matchAll(/\sstroke="([^"]*)"/g)].some((match) => match[1] !== "none");
  if (strokes) return null;
  const paths = [];
  for (const [, attributes] of svg.matchAll(/<path\b([^>]*?)\/?>/g)) {
    /**
     * One of the path's attributes.
     *
     * @remarks
     * `undefined` when the path does not have it.
     *
     * @sideEffects none
     * @param {string} name - The attribute.
     * @returns {string | undefined} Its value.
     */
    const attribute = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];
    const d = attribute("d");
    if (d === undefined || /\stransform=/.test(attributes)) return null;
    const fill = attribute("fill") ?? inherited;
    // An unfilled path draws nothing; a gradient or pattern cannot be drawn here.
    if (fill === "none") continue;
    if (fill.startsWith("url(")) return null;
    const path = { d, fill };
    if (attribute("fill-rule") === "evenodd" || attribute("clip-rule") === "evenodd") path.evenOdd = true;
    const opacity = attribute("opacity") ?? attribute("fill-opacity");
    if (opacity !== undefined) path.opacity = Number(opacity);
    paths.push(path);
  }
  return paths.length === 0 ? null : { box, paths };
}

/**
 * The icons the lookups name, drawn as paths.
 *
 * @remarks
 * Sorted by name, so the file only changes when an icon does.
 *
 * @sideEffects Reads the icons.
 * @returns {Record<string, unknown>} The icons by name.
 */
function drawable() {
  const wanted = new Set([
    table.file,
    ...Object.values(table.fileNames),
    ...Object.values(table.fileExtensions),
    ...Object.values(table.light.fileNames),
    ...Object.values(table.light.fileExtensions),
  ]);
  const available = new Set(readdirSync(icons).map((file) => file.replace(/\.svg$/, "")));
  const result = {};
  for (const name of [...wanted]
    .filter((icon) => available.has(icon))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const icon = parse(readFileSync(join(icons, `${name}.svg`), "utf8"));
    if (icon !== null) result[name] = icon;
  }
  return result;
}

const drawn = drawable();
/**
 * Keeps only lookups whose icon can be drawn.
 *
 * @remarks
 * Otherwise a name would resolve to an icon the phone does not have instead of the plain one.
 *
 * @sideEffects none
 * @param {Record<string, string>} lookup - Names or extensions to icons.
 * @returns {Record<string, string>} The drawable part.
 */
const keep = (lookup) => Object.fromEntries(Object.entries(lookup).filter(([, icon]) => icon in drawn));
const content = `${JSON.stringify({
  source: table.source,
  file: table.file,
  fileNames: keep(table.fileNames),
  fileExtensions: keep(table.fileExtensions),
  light: { fileNames: keep(table.light.fileNames), fileExtensions: keep(table.light.fileExtensions) },
  icons: drawn,
})}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== content) {
    console.error("file-icons.json is out of date: run node scripts/ios-file-icons.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(output, content);
  console.log(`${Object.keys(drawn).length} icons → ${output}`);
}
