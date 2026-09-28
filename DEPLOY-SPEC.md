# Deployment spec

How the static site is built from this repository and published to GitHub Pages. The app itself
is specified in [`src/chordpro-input/SPEC.md`](src/chordpro-input/SPEC.md).

## 1. Requirements

R1. `npm run build:site` produces a publishable directory from a fresh clone plus `npm ci`. No
sibling checkouts, no manual configuration.

R2. `<appPath>/` (`build/`) is the songbook builder app (`app/`, built with Vite).

R3. `/demo/songbook.html` is a songbook rendered from `src/chordpro-input/samples/`, with the
same folder's source files downloadable as `/demo/samples.zip`.

R4. The site root is a landing page rendered from [`index.md`](index.md), linking to the app,
the demo and the other pages.

R5. The build writes only to its output directory (`site/`) and its scratch directory
(`.site-build/`). It never modifies the working tree. In particular, the demo is built from a
copy of the samples folder.

R6. `chordprobook` (not yet on npm) is the commit recorded in `package-lock.json`. The same
commit is bundled into the app by Vite and embedded in every songbook, via the committed
`generated/chordprobook_browser_bundle.js`.

## 2. Files

| File | Purpose |
|---|---|
| `deploy.config.json` | site layout (§3) |
| `scripts/build-site.mjs` | the build (§4) |
| `scripts/render-markdown.mjs` | the landing and docs page Markdown renderer |
| `vite.config.js` | the app build, including the `songbookAppSource` transform (§4.3) |
| `index.md`, `docs/chordpro-format.md` | landing page and docs page sources |
| `.github/workflows/pages.yml` | CI (§5) |

## 3. deploy.config.json

```jsonc
{
  // Each entry renders one folder to site/<path>/. `title` is the demo book's
  // title; `zip` adds a zip of the folder's source files.
  "demo": [
    { "source": "src/chordpro-input/samples", "path": "demo", "title": "Sample songbook", "zip": "samples.zip" }
  ],

  // Where the app lands. "" (or absent) puts it at the site root, in which
  // case there's no room for a landing page.
  "appPath": "build",

  // Rendered with render-markdown.mjs. Both optional.
  "landing": { "source": "index.md", "path": "index.html" },
  "pages": [
    { "source": "docs/chordpro-format.md", "path": "chordpro-format.html" }
  ],

  "outDir": "site"
}
```

## 4. scripts/build-site.mjs

```
node scripts/build-site.mjs [--out site] [--work .site-build] [--strict] [--skip-tests] [--only app|demo]
node scripts/build-site.mjs --serve [--out site] [--port 4173]
```

In order:

### 4.1 Tests

`npm test`, unless `--skip-tests`.

### 4.2 Bundle check

`scripts/bundle-chordprobook-for-browser.mjs --out .site-build/…` regenerates the chordprobook
bundle from the installed (lockfile-pinned) chordprobook and compares it with the committed
copy. A difference means the committed bundle is stale. That's a warning, or an error under
`--strict` (which CI uses).

### 4.3 The app

`vite build` using `vite.config.js`, into `site/<appPath>/`. This runs first because Vite empties
its output directory, which is the site root when `appPath` is empty. `base: "./"` keeps asset
paths relative, so the app works from any subpath.

`vite.config.js`'s `songbookAppSource` plugin matters for correctness, not just size.
`songbook_html.js` embeds `initSongbookApp` in every songbook as source text. Left alone, that
text would be the bundler's version of the function (renamed parameters, stripped comments,
minified names), and a renamed free global would break every songbook the app writes. The plugin
replaces `initSongbookApp.toString()` with a string literal of the function's source as Node
reads it. So a songbook made in the browser is the same page the CLI writes.

### 4.4 Landing page and docs pages

Each `landing`/`pages` entry is rendered from the working tree to `site/<path>`.

### 4.5 Demo songbooks

For each `demo` entry, the source folder is copied to `.site-build/demo/<path>/`, minus any
generated files it contains. Then `build-songbook.mjs --file songbook.html [--title …]` runs on
the copy, and the result is copied to `site/<path>/` with an `index.html` that redirects to
`songbook.html`. With `zip`, the source folder's own files (not the generated ones) are zipped
alongside.

### 4.6 Finish

An empty `.nojekyll` goes in the site root, and the build prints the resulting tree.

`--serve` skips all of this and serves an existing `site/` at `http://localhost:<port>/`.
`--only app|demo` builds just that part (plus the Markdown pages).

## 5. CI

`.github/workflows/pages.yml`: checkout, Node 20, `npm ci`, `npm test`,
`node scripts/build-site.mjs --strict`, then upload `site/` and deploy with
`actions/deploy-pages`. It runs on `workflow_dispatch`, and on pushes to `main`. The default
branch is currently `master`, so in practice it runs only when triggered by hand.

One-time setup: repo Settings → Pages → "Build and deployment" → Source: "GitHub Actions".

## 6. Privacy

A GitHub Pages site on a public repository is public. The demo is only the sample songs.
Songbooks people make in the app stay on their own machines: the app runs entirely in the
browser and uploads nothing.
