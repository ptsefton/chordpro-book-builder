// Generates src/songbook/generated/songbook_fonts.js: the @font-face rules
// for the songbook's text font, with the font files themselves embedded as
// data: URIs. A songbook has to work as one file, opened offline from disk,
// so it can't fetch a web font from anywhere.
//
// The font is Atkinson Hyperlegible Next (Braille Institute; SIL Open Font
// License 1.1, which allows embedding), chosen for reading at a distance:
// letters that are easily confused (I l 1, O 0, rn m) are drawn to stay
// distinct, with open shapes and generous spacing. Latin subset only, in the
// regular and bold weights, upright and italic — about 50 KB in all.
// Characters outside the subset fall back to the system sans.
//
// Run after changing the font package or the selection below:
//   node scripts/embed-fonts.mjs [--out <file>]
// --out writes somewhere other than the committed location — build-site.mjs
// uses it to check the committed copy isn't stale.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "node_modules", "@fontsource", "atkinson-hyperlegible-next");
const FAMILY = "Atkinson Hyperlegible Next";
const FACES = [
  { weight: 400, style: "normal" },
  { weight: 700, style: "normal" },
  { weight: 400, style: "italic" },
  { weight: 700, style: "italic" },
];

const outIndex = process.argv.indexOf("--out");
const outputFile = outIndex > 0
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(root, "src", "songbook", "generated", "songbook_fonts.js");

const version = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
const faces = FACES.map(({ weight, style }) => {
  const file = path.join(packageDir, "files", `atkinson-hyperlegible-next-latin-${weight}-${style}.woff2`);
  const base64 = readFileSync(file).toString("base64");
  return `@font-face{font-family:"${FAMILY}";font-style:${style};font-weight:${weight};font-display:block;`
    + `src:url(data:font/woff2;base64,${base64}) format("woff2");}`;
});

// The OFL asks that the copyright and licence travel with the font; this
// comment goes into every songbook's stylesheet alongside it.
const notice = `/* ${FAMILY} — Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors `
  + "(https://github.com/googlefonts/atkinson-hyperlegible-next). "
  + "Licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). "
  + `Latin subset from @fontsource/atkinson-hyperlegible-next ${version}. */`;

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(
  outputFile,
  "// GENERATED FILE — do not edit by hand.\n"
    + "// Produced by scripts/embed-fonts.mjs; re-run it after changing the font.\n"
    + `export const SONGBOOK_FONT_FAMILY = ${JSON.stringify(FAMILY)};\n`
    + `export const SONGBOOK_FONT_FACE_CSS = ${JSON.stringify(`${notice}\n${faces.join("\n")}`)};\n`,
);
console.log(`Wrote ${path.relative(root, outputFile)} (${FACES.length} faces).`);
