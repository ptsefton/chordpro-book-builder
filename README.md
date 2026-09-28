# ChordPro Songbook Builder

A browser app that turns a folder of [ChordPro](https://www.chordpro.org/) song charts and
Markdown setlists into `songbook.html`: a standalone, interactive, printable songbook page (song
list, transposition, chord diagrams, setlists, print modes) that needs no server to open.

**Use it:** <https://ptsefton.com/chordpro-book-builder/build/>. Needs a desktop Chrome or Edge,
because it reads and writes a folder on your computer (the File System Access API).

**Offline:** the app is one self-contained HTML file. Use the "Download for offline use" link at
the top of the page, then open the saved file in Chrome or Edge. It works without an internet
connection.

1. **Choose your song folder.** Songs are `.cho`, `.pro` or `.cho.txt`; setlists are
   `.setlist.md`; subfolders are included.
2. **Name your songbook:** a title, and the file name to save it as. Both are remembered for next
   time.
3. **Make songbook.** If a setlist entry matches more than one song, you're asked which one you
   meant first. Afterwards the app lists anything worth checking: keys it had to guess, songs
   whose key looks like it was written "as heard" with a capo, setlist entries that matched
   nothing, and old `{st:}` credits. Each comes with a button to review or fix it.

Alongside the songbook, each build writes an [RO-Crate](https://www.researchobject.org/ro-crate/)
(`ro-crate-metadata.json` plus a `ro-crate-preview.html` that redirects to the songbook). The
crate is where the songbook's data comes from, and where your choices (title, file name, setlist
matches, confirmed keys) are kept between visits.

See [`SPEC.md`](SPEC.md) for the full design and
[`docs/chordpro-format.md`](docs/chordpro-format.md) for the ChordPro dialect it reads.

## Layout

```
app/                    the web app: index.html, main.js, app.css, modal.js, folder_store.js
src/songbook/           everything that builds or patches a songbook (no DOM outside the *_action.js modals)
  chordpro_crate.js       folder walk, song/setlist parsing into RO-Crate entities, matching, key checks
  songbook_build.js       build orchestration: crate + songbook + preview, title/filename handling
  songbook_html.js        renders the songbook page from a crate
  *_action.js             the review tools (setlist matches, keys, capo/key, {st:} credits)
  build-songbook.mjs      the same build as a CLI
scripts/                build-site.mjs (GitHub Pages), the chordprobook bundle generator, the {st:} CLI
```

[`chordprobook`](https://github.com/ptsefton/chordprobook-js), the ChordPro parsing and rendering
library, isn't on npm yet. It's a `github:` dependency, pinned to a commit by `package-lock.json`.

## Development

```
npm install
npm run dev      # the app at http://localhost:5173/
npm test
```

To work against a local checkout of `chordprobook` instead of the pinned commit:

```
npm install ../chordprobook-js --no-save
npm run generate:chordprobook-bundle
```

`--no-save` keeps `package.json`/`package-lock.json` on the pinned commit, and `npm ci` puts it
back. The songbook page embeds a copy of chordprobook
(`src/songbook/generated/chordprobook_browser_bundle.js`, committed), so regenerate it after
any chordprobook change. `build:site --strict` fails if the committed copy is stale.

## Command line

The same build, with no browser:

```
npm run build:songbook -- <folder> [--title "My Songbook"] [--file my-songbook.html]
```

Title and file name default to whatever the folder's last build recorded. Ambiguous setlist
matches reuse any choice made earlier in the app; otherwise the song closest to the setlist in
the folder tree is used.

`npm run fix:st-directive -- <folder>` is the command-line version of the `{st:}` credit fixer
(SPEC.md §15).

## Publishing

`npm run build:site` builds `site/`: a landing page from [`index.md`](index.md), the app at
`/build/`, a demo songbook at `/demo/` (from `src/songbook/samples/`, plus a zip of its
source files), and [`docs/chordpro-format.md`](docs/chordpro-format.md). `npm run preview:site`
serves the result locally. `.github/workflows/pages.yml` deploys it to GitHub Pages. See
[`DEPLOY-SPEC.md`](DEPLOY-SPEC.md).
