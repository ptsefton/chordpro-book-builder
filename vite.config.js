// The app lives in app/; `npm run dev` serves it, and build-site.mjs builds
// it into site/build/ (DEPLOY-SPEC.md) as one self-contained index.html —
// see inlineIntoHtml below.
import { defineConfig } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SONGBOOK_HTML = fileURLToPath(new URL("./src/songbook/songbook_html.js", import.meta.url));
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

// Folds the built JS and CSS into index.html itself, so the whole app is one
// file that can be saved and opened offline (file://) with nothing else next
// to it. Runs on the final bundle, so it sees exactly what would otherwise
// have been written to assets/.
function inlineIntoHtml() {
  return {
    name: "inline-into-html",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlAsset = bundle["index.html"];
      if (!htmlAsset) this.error("inline-into-html: no index.html in the bundle");
      let html = String(htmlAsset.source);

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === "index.html") continue;
        const code = output.type === "chunk" ? output.code : String(output.source);
        const ref = `./${fileName}`;
        if (fileName.endsWith(".js")) {
          // Inline script text ends at the first "</script" whatever quotes
          // it's in, and "<!--" can switch the parser into its legacy
          // escaped mode. esbuild already escapes both inside strings; if
          // either ever turns up anyway, fail rather than ship a broken page.
          if (/<\/script|<!--/i.test(code)) this.error(`inline-into-html: ${fileName} contains "</script" or "<!--"`);
          const tag = new RegExp(`<script type="module"[^>]*src="${escapeRegExp(ref)}"[^>]*></script>`);
          if (!tag.test(html)) this.error(`inline-into-html: no <script> for ${fileName} in index.html`);
          html = html.replace(tag, () => `<script type="module">\n${code}</script>`);
        } else if (fileName.endsWith(".css")) {
          const tag = new RegExp(`<link rel="stylesheet"[^>]*href="${escapeRegExp(ref)}"[^>]*>`);
          if (!tag.test(html)) this.error(`inline-into-html: no <link> for ${fileName} in index.html`);
          html = html.replace(tag, () => `<style>\n${code.replace(/<\/style/gi, "<\\/style")}</style>`);
        } else {
          this.error(`inline-into-html: don't know how to inline ${fileName}`);
        }
        delete bundle[fileName];
      }
      htmlAsset.source = html;
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default defineConfig({
  root: "app",
  base: "./",
  plugins: [songbookAppSource(), inlineIntoHtml()],
  build: {
    outDir: "../site/build",
    emptyOutDir: true,
    // One chunk, nothing fetched at runtime: no preload polyfill (there is
    // nothing to preload) and no separate CSS or asset files.
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
