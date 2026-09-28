// The app lives in app/; `npm run dev` serves it, and build-site.mjs builds
// it into site/build/ (DEPLOY-SPEC.md).
import { defineConfig } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SONGBOOK_HTML = fileURLToPath(new URL("./src/chordpro-input/songbook_html.js", import.meta.url));
const PLACEHOLDER = "const SONGBOOK_APP_SOURCE = initSongbookApp.toString();";

// songbook_html.js embeds initSongbookApp in every songbook it renders, as
// source text. Left to itself, that text would be whatever the bundler made
// of the function (renamed parameters, stripped comments, minified names) —
// and any free global it happened to rename would break every songbook the
// app writes. This swaps in the function's source as Node sees it instead,
// read fresh from the file on every build (and on every change under
// `npm run dev`).
function songbookAppSource() {
  return {
    name: "songbook-app-source",
    async transform(code, id) {
      if (id !== SONGBOOK_HTML) return null;
      if (!code.includes(PLACEHOLDER)) {
        this.error(`songbook-app-source: expected "${PLACEHOLDER}" in songbook_html.js`);
      }
      const mod = await import(`${pathToFileURL(SONGBOOK_HTML).href}?t=${Date.now()}`);
      const source = mod.initSongbookApp.toString();
      return { code: code.replace(PLACEHOLDER, `const SONGBOOK_APP_SOURCE = ${JSON.stringify(source)};`), map: null };
    },
  };
}

export default defineConfig({
  root: "app",
  base: "./",
  plugins: [songbookAppSource()],
  build: {
    outDir: "../site/build",
    emptyOutDir: true,
  },
});
