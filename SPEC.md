# ChordPro songbook builder — spec

## 1. What this app does

The songbook builder turns a folder of ChordPro song files and Markdown setlists into an
RO-Crate, and then renders that crate into a standalone, interactive, printable songbook HTML
page, written back into the same folder. It is a standalone browser app (`app/`, built with
Vite) plus a Node CLI (`build-songbook.mjs`) that runs the same build without a browser.

It has three stages:

- **Harvesting** (`chordpro_crate.js`, orchestrated by `songbook_build.js`): walks the chosen
  folder, parses each song and setlist file, and produces RO-Crate entities for them. This
  stage only reads the source files — it never edits songs, transposes chords, or draws chord
  diagrams.

- **Metadata entry and cleanup** (`fix_st_directive_action.js`, `fix_st_directive_ui.js`,
  `st_directive.js`, `scripts/fix-st-directive.mjs`, and the review tools
  `key_review_action.js`/`normalize_capo_key_action.js`/`setlist_match_action.js`): tools the
  app offers after a build, for fixing things the build had to guess or that old charts got
  wrong — e.g. `{st: ...}` used as a stand-in for a performer or composer credit, which
  predates this project's own `{artist}`/`{subtitle}` split (§5). Unlike Harvesting and
  Songbook rendering, some of these tools **can** write back into song files: the `{st:}`
  fix always does (§15), and the key tools do when their write-back checkbox is ticked
  (§17, §18) — always under a human's own choice, after first backing up the affected files
  to a zip kept inside the folder itself.

- **Songbook rendering** (`songbook_html.js`, written out by `songbook_build.js`'s
  `writeOutputs`): reads the crate and produces the songbook page (`songbook.html` by
  default; the filename is chosen in the app — §3), a single file containing the crate's own
  data plus a client-side app that displays it — a song list, individual song views with
  transposition and chord diagrams, setlists, and a print mode. This file is meant to be
  opened directly (including as a `file://` URL) with no server and no build step.
  `ro-crate-preview.html` becomes a small redirect to it (§10).

All three stages depend on [`chordprobook`](https://github.com/ptsefton/chordprobook-js) (a
`github:` dependency, `"chordprobook": "github:ptsefton/chordprobook-js#main"` in
`package.json`) for ChordPro/setlist parsing, chord transposition, and chord-diagram rendering.

## 2. Scope

**In scope:**
- Discover song files (ChordPro) and setlist files (Markdown) in a picked folder.
- Parse each song's metadata directives and capture its full raw text.
- Parse each setlist's structure (title, set groupings, ordered entries, per-entry
  overrides, freeform notes) and resolve each entry to a song.
- Produce RO-Crate entities for both, written out as `ro-crate-metadata.json`.
- Render the resulting crate into a standalone songbook HTML page: song list, song view,
  setlists, key/capo/instrument controls, chord diagrams, print mode.
- TODO - when PT asks: 
  - Bundling any default chord-shape data or `{define:}` directives from a song's own text — chord shapes shown on screen or in print come only from chordprobook's own bundled data
  (

**Out of scope (permanent, not deferred):**
- Editing songs or setlists, or writing back to the source folder — true of Harvesting and
  Songbook rendering (§1), which never do either. The deliberate exceptions are the
  cleanup and review tools (§1, §15, §17, §18), run only on request, after a build, and each
  authorised for one narrow change to song files.

- Any music-theory logic beyond what chordprobook already provides — transposition, capo
  math, and Nashville numbering are chordprobook's responsibility, not reimplemented here.

**Deferred (§9):** creating or editing setlists in the songbook page; loading additional
songs into an already-open page; exporting the crate as a downloadable RO-Crate file.

## 3. The app

The app is a single page, `app/index.html`, driven by `app/main.js`, which is only the page
around the build: everything that actually builds or patches a songbook lives in
`src/songbook/`. The build inlines all of it into one self-contained HTML file
(DEPLOY-SPEC.md §4.3), so the app works offline once saved. The page's "Download for offline
use" link saves that file. When opened from `file://`, the link is hidden and the header links
point at the published site. Supporting modules:

- `app/modal.js` — `openModal({ title, modalClassName, onDismiss, render(body, close) })`, a
  minimal `<dialog>`-based shell. It resolves with whatever the tool passes to `close(value)`;
  dismissing (×, Escape, a backdrop click) resolves with `onDismiss()`'s return value, or
  `undefined`. The review tools build their own modal bodies and inject their own styles.
- `app/folder_store.js` — remembers the last folder handle in IndexedDB, so a return visit
  offers "Reopen …" instead of a trip through the folder picker. Best-effort: blocked storage
  just means nothing is remembered.
- `src/songbook/fs_helpers.js` — the small File System Access API helpers everything
  else shares (`verifyPermission`, `fileExists`, `readFileText`, `readJsonFromFolder`,
  `writeFile`, `getFileHandleAtPath`, `writeFileAtPath`). Everything takes a
  `FileSystemDirectoryHandle`-shaped object, so tests and the CLI can pass in-memory or
  Node-backed stand-ins.
- `src/songbook/songbook_build.js` — build orchestration: `buildSongbook` (harvest the
  folder, record title and filename in the crate, write everything out), `writeOutputs`
  (writes `ro-crate-metadata.json`, the songbook page under the recorded filename, and
  `ro-crate-preview.html` — always overwriting; there is no overwrite option),
  `readBookSettings`, `normalizeSongbookFilename`, `songbookFileFromCrate`,
  `recordSongbookFile`, and the `CRATE_FILE`/`PREVIEW_FILE`/`DEFAULT_SONGBOOK_FILE` names.

**The flow** is three steps:

1. **Choose your song folder.** `showDirectoryPicker` (read-write), then `scanFolder`
   (`chordpro_crate.js`) reports how many songs and setlists it holds. A folder with neither
   stops here.
2. **Name your songbook.** Two fields: **Title** (the root dataset's `name`, used as the
   songbook's own title — §10) and **File name** (the songbook page's filename, default
   `songbook.html`). Both are prefilled by `readBookSettings` from an existing
   `ro-crate-metadata.json` in the folder, else from the folder's own name and
   `songbook.html`. `normalizeSongbookFilename` tidies what was typed: never a path (path
   characters become `-`), always `.html` (`.htm` is left alone), can't start with `.`, and can't be one of the
   generated RO-Crate names (`GENERATED_FILENAMES`) other than `songbook.html` itself.
   "Make songbook" first awaits `resolveSetlistMatches` (the pre-build soft gate, §16), then
   runs `buildSongbook`. If the filename changed since the last build, the old page is left in
   place and the log says so.
3. **Your songbook.** A result card with "Open songbook" and a "Worth a look" list of checks
   read from the crate just written, each with a button where there is something to do:
   - guessed keys → `reviewKeyGuesses` (§17);
   - keys that look written as heard with the capo on → `normalizeCapoKeys` (§18);
   - ambiguous setlist matches → `reviewSetlistMatches` (§16);
   - unresolved setlist entries (`extractUnresolvedSetlistEntries`, `chordpro_crate.js`) —
     information only, each listed with its setlist and set, since the fix is in the setlist
     or song file itself;
   - old `{st:}` credits → `fixStDirectives` (§15).

   Opening a folder that already has a crate and its songbook goes straight to this card.

**Where the settings live.** Title and filename are stored in the crate itself — the title as
the root dataset's `name`, the filename as a `File` entity the root dataset `hasPart` (§7) —
so the next visit to the same folder prefills both from what is already on disk, with nothing
stored anywhere else.

**The review tools** (`setlist_match_action.js`, `key_review_action.js`,
`normalize_capo_key_action.js`, `fix_st_directive_action.js`) are plain async functions taking
`{ dirHandle, log, openModal }`, each opening its own modal and reporting whether anything
changed. The three review tools read the crate fresh off disk, patch it, and re-render via
`writeOutputs` (so a custom songbook filename is respected); `fixStDirectives` only touches
song files and leaves the crate to the rebuild that follows. **After a tool that rewrote song files** — key or capo write-back, or
the `{st:}` fix — the app runs "Make songbook" again automatically, so the crate's copy of
those songs catches up; a tool that only patched the crate just refreshes the result card.

`build-songbook.mjs` (§10) runs the same `buildSongbook` from the command line.

## 4. File discovery

The picked folder is scanned recursively; subfolders carry no structural meaning. Each file
is classified by extension:

| Extension (default) | Treated as |
|---|---|
| `.pro`, `.cho`, `.cho.txt` | Song (ChordPro) |
| `.setlist.md` | Setlist (Markdown) |
| anything else | ignored |

The walk takes `opts.songExtensions`/`opts.setlistSuffix` overrides
(`harvestFilesAndTitles`, `chordpro_crate.js`), but the app and CLI always use the defaults.

Dotfiles and common editor/OS artifacts (`.DS_Store`, `~$*`, etc.) are skipped, as are the
files a build writes (`GENERATED_FILENAMES`) — a songbook saved under a custom filename needs
no entry there, since only song and setlist extensions are ever harvested.

## 5. Parsing a song file

Only metadata extraction happens here — no rendering, transposition, or chord-diagram logic.

| Directive(s) | Extracted as |
|---|---|
| `{title}` / `{t}` | `name` |
| `{artist}` | `performer` |
| `{subtitle}` / `{st}` | `subtitle` |
| `{key}` | `musicalKey` |
| `{capo}` | `custom:capo` (string containing an integer) |
| `{transpose}` / `{tr}` | `custom:transpose` (string — either a signed integer or a key name, e.g. `Em`) |
| `{composer}` | `composer` |
| everything else | retained as part of raw text, not extracted |

Every directive is first-wins (the first occurrence in the file is kept; later repeats of
the same directive are ignored).

- **Raw text.** The file's original text, unmodified, is stored verbatim as `text` on the
  Song entity — so the crate can function without file access, independent of the metadata
  extracted from it above. **The Song entity is the only place this text is ever written** —
  a setlist entry naming the same song (§6) never carries its own copy.
- **Identity.** `@id` is the file's path relative to the picked folder.
- **Title fallback.** A file with no `{title}` directive falls back to its filename, minus
  extension with s/_/ /g.

## 6. Parsing a setlist file

Setlist files are Markdown with a specific dialect layered on top:

```
{Title: Gig number 1,000}      <- optional, first non-blank line only, {directive: value}
                                   syntax (not YAML frontmatter). Falls back to filename.

# Set 1                        <- a set heading (H1) — modelled as its own nested MusicPlaylist

Tune guitars to drop D now.   <- freeform text before the first entry becomes that set's own
                                   `text` — a Markdown note for the whole set, not any one song

## Slot Machine Baby           <- a setlist entry (H2): the heading text is matched against
                                   known song titles (§6.1)

> Play with a lively feel...   <- performance notes: any non-blank, non-heading line(s)
>> But not **that** lively!       immediately following an entry, up to the next heading,
                                   concatenated verbatim into that entry's own `text` and
                                   rendered as Markdown (§6.2). Blockquote ("> ") markup is
                                   not required — any non-blank, non-heading line counts as a
                                   note.

## Baby {transpose: -2}        <- inline {directive: value} after the title overrides that
                                   entry's transpose/capo for this performance, independent
                                   of the matched song's own values
```
- **Each entry is its own `MusicComposition`** — a proxy for one performance slot, linked to
  the canonical Song it performs via `specializationOf`. It never duplicates that Song's own
  full lyrics (§5) — the only `text` an entry ever carries is its own performance note, if it
  has one, a different kind of content under the same property name (§6.2, §7).
- **Sets within a setlist are marked with a Markdown `# Set 1` heading** — used to group songs
  for a multi-set gig. Where present, each set is modelled as its own nested `MusicPlaylist`
  entity, with `hasPart` pointing at that set's own entries; the top-level setlist's own
  `hasPart` then points at a mix of these set entities and any entries that appear before the
  first `#` heading at all (which stay direct children of the setlist itself, ungrouped,
  exactly as every entry behaved before `#` sets existed as their own entities). A setlist
  that never uses `#` produces zero set entities — a strict superset of the old behaviour, not
  a replacement for it in the common case. There is **no `custom:setName` any more** — which
  set (if any) an entry belongs to is expressed structurally, by which set's own `hasPart`
  references it, not as a flat string property on the entry (see §7's entity-shape examples).
  Freeform text between a set's own `#` heading and its first entry (e.g. "Tune guitars to
  drop D now") becomes that set entity's own `text` (rendered as Markdown — §6.2) — a warm-up
  note for the whole set, not any one song — present only when such text actually exists.
  Grouping is by consecutive runs of matching set-heading text: two `#` sections that happen to
  share a literal name are only treated as one group when they're directly adjacent, since
  grouping works from the flat entry list alone, without tracking each `#` line's own position
  in the file. A setlist that genuinely repeats a set name for two separate, non-adjacent
  sections is a known, accepted edge case this app doesn't try to disambiguate further
  (`test-chordpro-crate.mjs` documents the exact behaviour, rather than treating it as a bug).
- **Entry-level overrides.** `{transpose: N}` / `{tr: N}` and `{capo: N}` found inline on a
  `##` line become `custom:transpose` / `custom:capo` directly on the entry, taking
  precedence over the matched Song's own values — the same song can appear in two setlists, or even the same setlist performed in two different keys.

### 6.1 Matching an entry to a song

1. Strip any trailing `{...}` directive text and surrounding whitespace from the heading to
   get the bare entry name.
2. Attempt an exact match against a song's title (case-insensitive).
3. If no exact match, build a regex by joining the entry name's words with `.*?` and test it
   case-insensitively against every song title (`"Amazing"` matches `"Amazing Grace"`). This
   is intentionally permissive.
4. **Zero matches:** entry retained with no `specializationOf`; `custom:matchStatus:
   "unresolved"`.
5. **Exactly one match:** linked via `specializationOf`; `custom:matchStatus` is `"exact"` or
   `"fuzzy"` depending on which step matched.
6. **Multiple matches:** `matchEntryToSong` (chordprobook) itself just returns every candidate
   in whatever order it found them, picking the first as a placeholder —
   `chordpro_crate.js` doesn't use that placeholder as-is. It re-ranks the candidates by
   path-proximity to the setlist file (closest first — SPEC.md §16) and links `specializationOf`
   to the top-ranked one (so an entry always has a definite `specializationOf` when any match
   exists at all, the same guarantee as before), unless a human has already resolved this exact
   ambiguity via §16's own review step, in which case that choice wins instead. Either way the
   ambiguity itself is recorded as data: `custom:matchStatus: "ambiguous"` plus
   `custom:matchCandidates`, listing every candidate's `@id` in that same closest-first order.
   A build-log warning is also emitted.

`matchStatus` is present on every entry, not only ones that failed to resolve. See §16 for how
the app lets a human resolve ambiguous matches (as opposed to `matchEntryToSong`'s own
placeholder pick, which is all a bare chordprobook consumer with no file-path context to rank
by ever gets).

### 6.2 Setlist and set display

A setlist displays as a list of its songs, divided by "Set N" headings when the source markdown
has any, each entry showing its own performance note underneath (§12's "Credit line and key in
list rows" section, and "Setlist-entries search", cover the row-by-row detail; this section is
about the setlist-as-a-whole and song-view behaviour). Clicking a song shows that song with
prev/next arrows scoped to that setlist's own order, not the global song list, until the reader
explicitly leaves it (SPEC.md §11's "A setlist becomes the active browsing context" note).

**Notes render as Markdown, not plain text — a deliberate property choice, not just a display
one.** Both an entry's own note and a set's own note (the freeform text before its first
entry, §6) are written to the crate as `text` rather than `description` — a canonical Song
entity's own `text` is its verbatim ChordPro source, but this is a genuinely different kind of
content living under the same property name: a short Markdown note, meant to be rendered, not
parsed as ChordPro or read as an unstructured summary. `renxderNoteMarkdown` (`songbook_html.js`)
supports paragraphs, blockquote lines (`>`/`>>`, any depth flattened to one level), numbered
(`1. `) and bullet (`- `/`* `) lists, and inline `**bold**`/`*italic*` — not a general Markdown
implementation, just what a real setlist note has actually used (chordprosite's own sample
setlist already mixed a blockquote with `**bold**`; `sample.setlist.md` here now also
demonstrates a set-level paragraph-then-list). It builds real DOM nodes via `createElement`
rather than an HTML string for `innerHTML` — the same reason `buildSongPrintPage`'s own table of
contents does (§13): this function's source is embedded into the page via `.toString()`, so an
HTML-string template literal spelling out an actual tag would sit in the page's own embedded
script as literal text, indistinguishable from the page having actually pre-rendered one.

**Opening a song from within a setlist shows that entry's own note as a modal over the song
itself**, not only inline back in the list a reader may have already scrolled away from — PT:
"put up a modal over the song with the notes on it eg 'Tune guitars to drop D now'". Re-decided
fresh on every `showSong()` call, not just once per setlist, since a different entry can have a
different note (or none at all). Dismissed by a click anywhere on it, not a specific close
button — "any click on that should make it go away" (PT's own words). A `#setlist-notes-checkbox`
in the song view's own menu-bar overflow, checked by default, controls whether this happens at
all; unchecking it while a note is already showing hides it immediately, and it stays hidden
until re-checked. Hidden itself, along with the modal, whenever there's no active setlist to
begin with (opening a song from the global list) — there's no entry, and so no note, in that
context. Never shown for a *set's* own note (only an entry's) — that note is already visible
once, inline, before the reader ever opens a song from that set; showing it again on every song
within it would be redundant.


## 7. Entity shapes

**Root dataset and the songbook file.** The root dataset's `name` is the book title chosen in
the app (§3) — `applyRootDataset` (`chordpro_crate.js`) falls back to "Songbook" when none is
given — and is what the songbook page uses as its own title (§10). The songbook page itself is
recorded as a `File` entity, referenced from the root dataset's `hasPart`, by
`recordSongbookFile` (`songbook_build.js`); a later build under a different filename replaces
it (and its `hasPart` reference) rather than adding a second one. `songbookFileFromCrate`
finds it again as the `File` with `encodingFormat: "text/html"` that isn't
`ro-crate-preview.html`; a crate that records none means plain `songbook.html`.

```jsonc
{
  "@id": "songbook.html",
  "@type": "File",
  "name": "Songbook",
  "description": "Interactive, printable songbook generated from the songs and setlists in this crate.",
  "encodingFormat": "text/html"
}
```

No custom `@type` is minted. A Song and a setlist entry are both typed `MusicComposition`; a
Setlist and each of its own nested "#" sets (§6) are both typed `MusicPlaylist` — told apart
only by `@id` shape, never by type: a set's own `@id` is always `<setlist path>#set-N`, which
a real setlist file's own path can never look like (a "#" isn't valid in one).

```jsonc
{
  "@id": "AmazingGrace.cho.txt",
  "@type": "MusicComposition",
  "name": "Amazing Grace",
  "text": "{title: Amazing Grace}\n{key: G}\n\nA-[G]maz-ing [G7]Grace, ...",
  "musicalKey": "G"
  // composer / performer / subtitle / custom:capo / custom:transpose are omitted entirely
  // when the source file had no matching directive — never written as null or empty.
}
```

```jsonc
{
  "@id": "i_called_your_name.cho.txt",
  "@type": "MusicComposition",
  "name": "I Called Your name",
  "text": "{title: I Called Your name}\n{st: Peter Sefton}\n...",
  "musicalKey": "C",
  "subtitle": "Peter Sefton",
  // {capo: 2} would appear as "custom:capo": "2" — a string, like every other
  // extracted directive here, not the JS number ChordProSong itself parses it into.
  "custom:transpose": "+7"
}
```

```jsonc
{
  "@id": "sample.setlist.md",
  "@type": "MusicPlaylist",
  "name": "Gig number 1,000",
  "hasPart": [
    { "@id": "sample.setlist.md#set-1" },
    { "@id": "sample.setlist.md#set-2" }
    // A mix of set references and direct entry references, in performance
    // order — an entry appearing before the first "#" heading at all would
    // sit directly in this array instead of inside a set (§6).
  ]
},
{
  "@id": "sample.setlist.md#set-1",
  "@type": "MusicPlaylist",
  "name": "Set 1",
  "text": "Tune guitars to drop D now.",
  // Only present when the source markdown actually had freeform text
  // between "# Set 1" and its first entry (§6) — most sets have none.
  // `text`, not `description` — it can be Markdown, rendered as such
  // (§6.2), which `description` doesn't conventionally imply.
  "hasPart": [
    { "@id": "sample.setlist.md#entry-1" },
    { "@id": "sample.setlist.md#entry-2" }
  ]
},
{
  "@id": "sample.setlist.md#entry-1",
  "@type": "MusicComposition",
  "name": "Slot Machine Baby",
  "specializationOf": { "@id": "slot_machine_baby.cho.txt" },
  "custom:matchStatus": "exact",
  "text": "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!"
  // Not the canonical Song's own full lyrics — this is the entry's own
  // performance note (§6.2), a deliberate overload of the same property
  // name the Song entity above uses for something different (its own
  // verbatim ChordPro source). No "custom:setName" either — which set this
  // entry belongs to is that set's own hasPart (above) referencing it, not
  // a property here.
}
```

| Field | Property | Standard or custom? |
|---|---|---|
| a song's title / an entry's raw heading | `name` | standard (`Thing`) |
| a song's full source text, *or* an entry's/set's own Markdown note | `text` | standard (`CreativeWork`) — a deliberate overload: on a canonical Song it's the verbatim ChordPro source; on a setlist entry or a set (§6) it's an unrelated, shorter piece of Markdown, rendered as such (§6.2), never both on the same entity |
| a song's key | `musicalKey` | standard (`MusicComposition`) |
| a song's composer credit | `composer` | standard (`MusicComposition`) — a bare string, not a Person/Organization reference |
| a song's `{artist}` credit | `performer` | standard (`MusicComposition`/`Event`) — a bare string, not a Person/Organization reference, same simplification as `composer` |
| a song's `{subtitle}`/`{st}` | `subtitle` | standard (`CreativeWork`) |
| a setlist's or a set's ordered members | `hasPart` | standard (`CreativeWork`) — this is what expresses a set's own membership in its setlist, and an entry's in its set, structurally (§6); there is no separate "which set does this belong to" property on an entry |
| an entry's link to the song it performs | `specializationOf` | standard (`CreativeWork`) |
| capo position | `custom:capo` | custom — a string containing an integer on a Song entity (a song's own `{capo}`, SPEC.md §5); a JS number on a setlist entry (an inline `{capo: N}` override, parsed independently by `Setlist.js`, SPEC.md §6) — the one property in this crate whose type depends on which kind of entity carries it |
| transpose value | `custom:transpose` | custom |
| the build's confidence in a match | `custom:matchStatus` | custom |
| every candidate when a match was ambiguous, closest-in-the-tree first | `custom:matchCandidates` | custom (SPEC.md §16) |
| whether a song's `musicalKey` was guessed, human-confirmed, or never touched at all | `custom:keyStatus` | custom (SPEC.md §17) — absent for an authored `{key:}`, same "present only when it means something" convention as `custom:matchCandidates` |

`rdf:Property` definitions are added only when at least one entity in the build actually
uses them:

| `@id` | `name` |
|---|---|
| `arcp://name,custom/terms#capo` | Capo |
| `arcp://name,custom/terms#transpose` | Transpose |
| `arcp://name,custom/terms#matchStatus` | Match Status |
| `arcp://name,custom/terms#matchCandidates` | Match Candidates |
| `arcp://name,custom/terms#keyStatus` | Key Status |

(`name`, `text`, `musicalKey`, `composer`, `performer`, `subtitle`, `hasPart`,
`specializationOf` are standard schema.org properties already defined by every profile's base
context — none of them gets an entry in the table above. `description` isn't used anywhere in
this crate at all — notes use `text` instead, deliberately, per this section's own note above.)

## 8. File layout

```
app/                           the browser app (§3) — Vite root
  index.html                   the page: folder, name, result steps
  main.js                      the flow and the "Worth a look" checks
  app.css                      app styles (including the generic modal/row classes the
                               review tools use)
  modal.js                     <dialog>-based openModal()
  folder_store.js              remembers the last folder in IndexedDB ("Reopen …")
vite.config.js                 Vite config: the songbookAppSource transform (§10) and single-file
                               inlining (DEPLOY-SPEC.md §4.3)
SPEC.md                        this document
src/songbook/
  songbook_build.js            build orchestration: buildSongbook, writeOutputs, title/filename
                               settings and the songbook File entity — §3, §7
  fs_helpers.js                shared File System Access API helpers — §3
  chordpro_crate.js            folder walk and RO-Crate entity assembly; imports
                               ChordProSong/parseSetlist/matchEntryToSong/guessKey from
                               chordprobook
  crate_index.js               dependency-free @id/@type index over a written crate's JSON
                               (buildCrateIndex/toArray/firstValue/resolveRef/entitiesOfType)
                               — does not use the `ro-crate` npm library
  songbook_html.js             renders the crate into the songbook page — see §10-§13
  generated/
    chordprobook_browser_bundle.js
                               generated; do not edit by hand — see §10
  st_directive.js              isomorphic {st:} match/rewrite core — see §15
  fix_st_directive_ui.js       browser-only shell (folder walk, zip backup, write-back) — §15
  fix_st_directive_action.js   fixStDirectives: the "Fix credits…" modal — §15
  setlist_match_action.js      resolveSetlistMatches (pre-build soft gate) and
                               reviewSetlistMatches — see §16
  key_review_action.js         reviewKeyGuesses, with optional backup + write-back — §17
  normalize_capo_key_action.js normalizeCapoKeys, with optional backup + write-back — §18
  build-songbook.mjs           standalone Node CLI running the same build — see §10
  samples/                     chordprosite's own sample files, used as test fixtures
  samples-large/               a larger, invented collection (same-titled songs, scattered
                               setlists) for exercising matching at scale
  test-chordpro-song.mjs       regression test for chordprobook's ChordProSong
  test-chordpro-setlist.mjs    regression test for chordprobook's parseSetlist/matchEntryToSong
  test-chordpro-crate.mjs      integration test for chordpro_crate.js against samples/
  test-crate-index.mjs         unit tests for crate_index.js
  test-songbook-build.mjs      songbook_build.js end to end, against an in-memory folder
  test-songbook-html.mjs       unit/integration tests for songbook_html.js
  test-st-directive.mjs        unit tests for st_directive.js
```

`chordprobook` is imported statically; Vite bundles it into the app.

Tests are colocated with the code, discovered recursively by `scripts/run-tests.mjs`.

A `docs/chordpro-format.md` file documents the ChordPro conventions this app expects for the
person writing song/setlist files.

## 9. Deferred and open

**Deferred (not built):**
- Creating a new setlist or editing an existing one from within the songbook page (adding
  songs, reordering by dragging, saving the update back into the HTML file).
- Loading additional songs into an already-open songbook page, from a folder or pasted
  ChordPro text.
- Exporting the crate as a downloadable RO-Crate (data only, or with source files written
  out via the File System Access API).


**Open questions:**
1. Whether a top-level folder should carry structural meaning (a grouping entity, as
   some other RO-Crate tools treat top-level folders), or remain unrepresented regardless
   of how files are organised on disk.
2. Whether archival fidelity — retaining byte-identical original files, not just their
   parsed text — is required, given the crate currently stores only parsed text.
3. Duplicate or near-duplicate song titles from different files are not deduplicated or
   cross-referenced in any way; they simply coexist as unrelated entities.


---

## 10. Songbook HTML output — what the file contains

`renderSongbookHtml(crateJson)` in `songbook_html.js` produces one self-contained HTML file,
written by `writeOutputs` (`songbook_build.js`) under whatever filename the crate records (§7)
— `songbook.html` unless the app was given another. It is a pure function of the crate JSON,
so a full build and every review tool that patches a crate on disk re-render it the same way.
The page's `<title>`, the song list's `<h1>`, and the printed book's title page all use the
root dataset's `name` (`bookTitleFromCrate`, re-expressed inline inside `initSongbookApp`),
falling back to "Songbook". It contains three `<script>` elements, all **classic, not
`type="module"`** — a module script's cross-origin rules block it entirely when the page is
opened as a `file://` URL, which is how this file is meant to be opened:

1. `<script type="application/ld+json" id="crate-data">` — the crate's own JSON-LD,
   pretty-printed, with a defensive escape of any literal `</script` inside it.
2. A classic `<script>` containing `CHORDPROBOOK_BROWSER_BUNDLE`, `CHORDPROBOOK_INSTRUMENTS_DATA`,
   and `CHORDPROBOOK_CHORD_DATA` — see below.
3. A classic `<script>` invoking `initSongbookApp(document, window)` — a plain function
   exported from `songbook_html.js` and embedded via `.toString()` (its actual source, not
   a hand-written duplicate), constituting the entire client-side app.

**`ro-crate-preview.html` is a redirect to this file, not a second preview.** `writeOutputs`
writes it right after the songbook, via `renderRedirectHtml(songbookFile)`: a plain
`<meta http-equiv="refresh">` to the songbook's filename, plus a link to it for anything that
doesn't follow the refresh. The songbook *is* this crate's human-readable preview; a second,
generic rendering of the same crate wouldn't show a song/setlist crate meaningfully anyway.
`ro-crate-preview.html` is kept as a real (if trivial) file because it is the conventional
RO-Crate entry point.

**Building a songbook without the app at all.** `build-songbook.mjs` is a standalone Node CLI
that runs the same `buildSongbook` the app does, directly against a real folder on disk, with
no browser and no File System Access API:

```
node src/songbook/build-songbook.mjs <folder> [--title "My Songbook"] [--file my-songbook.html]
npm run build:songbook -- <folder> [--title ...] [--file ...]
```

It wraps the folder in a small read-write stand-in for the File System Access API's own
directory-handle shape (`values()`/`getDirectoryHandle()`/`getFileHandle()`, with
`getFile()`/`createWritable()` on files) — `buildSongbook` has no idea whether it's talking to
a real browser handle or this Node-backed one — and so writes the same three files the app
does. Title and filename default to what `readBookSettings` finds in an existing crate (else
the folder name and `songbook.html`), exactly as the app prefills them; `--title`/`--file`
override. It never prompts: ambiguous setlist matches reuse any choice persisted in an earlier
crate (`extractPersistedSetlistMatches`, §16) and otherwise get the path-proximity default.
Reports song/setlist counts and any unresolved/ambiguous setlist-entry matches (§6.1) to
stdout.

**Embedding chordprobook.** `initSongbookApp` calls `ChordProSong`, `renderSong`,
`Transposer`, and `ChordDiagram` as bare globals, since nothing can `import` anything once
this is a classic script. Those globals, plus the two data constants above, are produced at
build time by `scripts/bundle-chordprobook-for-browser.mjs` (run via `npm run
generate:chordprobook-bundle`; nothing regenerates it automatically) from:
- chordprobook's own `chords/Transposer.js`, `chords/ChordDiagram.js`, `ChordProSong.js`,
  `Song.js` source, concatenated with `import`/`export` stripped and each file's body
  wrapped in its own closure exposing only its own exported names. **The per-file closure
  matters**: `ChordProSong.js` and `Song.js` each declare their own private
  `DIRECTIVE_NAMES`/`Directive`, and bare top-level declarations from both would collide as
  a `SyntaxError` once concatenated into one classic-script scope without it.
- `instruments.yaml`, parsed with the `yaml` package at generation time (a devDependency of
  this repo, used only by this script) and emitted as plain JSON — the browser never
  parses YAML itself.
- `chords/chord_data/*.cho`, parsed with chordprobook's `parseChordDataText()` at generation
  time and emitted as plain JSON — the browser never parses raw `.cho` text.

A generated `.js` file exporting plain string/JSON constants is what makes this importable
identically under Vite (the app's bundle) and under plain Node (this repo's own
tests and the CLI); a Vite `?raw` import only works under Vite, and `fs.readFileSync` only
works under Node.

**Keeping the embedded source intact under Vite.** `initSongbookApp` reaches the page as
source text (`const SONGBOOK_APP_SOURCE = initSongbookApp.toString();`), so in the app's
bundle it would otherwise be whatever the bundler made of the function — renamed parameters,
minified names — and any free global it renamed would break every songbook the app writes.
`vite.config.js`'s `songbookAppSource` transform plugin swaps that line for a string literal
of the function's source as Node sees it, read fresh on every build (and on every change under
`npm run dev`), so bundler renaming never reaches the embedded code; it fails the build if the
placeholder line is missing. The import-aliasing in `songbook_html.js` (the data constants
imported under different names from the bare globals `initSongbookApp` uses — see that file's
comments) is still in place and still matters: it keeps the function's free references from
ever binding to a module import, so the embedded text stays correct under plain Node (tests,
CLI) and in any bundling that doesn't run this transform.

`initSongbookApp` cannot import `crate_index.js` or chordprobook normally — it runs inside
the generated page, on whatever machine later opens it, not inside this app. It
re-implements the "is this a canonical song" check inline for the same reason: an entity is
a canonical Song, not a setlist-entry proxy, when it carries neither `specializationOf` nor
`custom:matchStatus` (§7) — the two share `MusicComposition` as their `@type`, so this is
never decided by @id shape or by which of an entity's *other* properties happen to be
present (an entry can carry its own `text` too now, its performance note — §6.2/§7 — so that
alone can't tell the two apart either). `specializationOf` is the semantically meaningful
signal (an entry that resolved to a song genuinely *is* a specialization of it — SPEC.md §6.1,
PROV's own term, not schema.org's, but already present in RO-Crate's own context);
`custom:matchStatus` covers the one case `specializationOf` can't: an *unresolved* entry has
neither, since there was nothing for it to specialize — common enough in a real, imperfectly-
matched setlist that it isn't a hypothetical edge case. `test-songbook-html.mjs` calls
`initSongbookApp` directly against a fake `document`/`window`, including simulating real
clicks, as the one copy of this logic that's actually tested.

## 11. Songbook HTML output — views and navigation

The page has five top-level views, each shown by hiding all the others (`setHidden()`
toggles a `hidden` class — **not** `element.style.display` directly: setting
`style.display = ""` clears an inline override and falls back to whatever the stylesheet
itself specifies, which for these elements is itself `display: none`; the `.hidden` CSS rule
carries `!important` because e.g. `#back-to-list-button`'s own `display: inline-flex` would
otherwise win on specificity while both apply):

| View | Shown by | Contains |
|---|---|---|
| `#list-view` | `showList()` | all songs (searchable, scrollable), each with a composer/artist/subtitle credit line and key (§12), a "Print this songbook" button, a "Setlists" button (hidden if the crate has none) |
| `#setlist-index-view` | `showSetlistIndex()` | every setlist by name (searchable, §12) |
| `#setlist-view` | `showSetlist(index)` | one setlist's entries (searchable, §12): position, heading (plus that set's own note, if it has one — §12), credit line and key (§12), match-status mark (§11), notes, print/notes-toggle controls |
| `#song-view` | `showSong(position)` | one song, with the sticky `#app-bar` (prev/next, fullscreen, instrument select, print, hide/show chords) and, inside `#song-content` itself, `#song-header` (title, key/capo — §12) |
| `#print-view` | `enterPrintView()` | whatever's being printed (§12) |

**`#app-bar`** is always mounted and sticky (not song-view-only — unlike everything else in
the table above, it isn't one of the five hidden/shown views), and is always a single line:
`flex-wrap: nowrap`, with `overflow-x: auto` as a fallback if a viewport is ever too narrow
for its contents, rather than wrapping onto a second line. `#prev-song-button` is first, so
it's leftmost by DOM order; `#next-song-button` gets its own `margin-left: auto` to push
itself to the right edge — nothing else in the bar is elastic now that the title (which used
to do that job by taking `flex: 1`) has moved into `#song-content` itself (§12), freeing up
the bar's own height for song content. `#fullscreen-button` (visible in every view, including
print, though it's excluded from the printed page itself — §12) sits right after
`#prev-song-button`; every other control in the bar (`#back-to-list-button`, `#menu-bar-
overflow`, `#menu-bar-overflow-toggle`, `#print-song-button`) is song-view-only and
`setHidden()` individually by every view-switching function — there's no single wrapper
element left whose own hidden state implies all of theirs, the way `#menu-bar-row2` once did
in an earlier two-row version of this bar.

**Small-screen overflow menu.** `#menu-bar-overflow` (a container for `#instrument-select`,
`#toggle-chords-button`, and `#print-song-button` — print moved in here from its own place in
the row specifically so a tight layout folds it under the hamburger menu too, rather than it
staying a fourth icon competing for room in the row itself) is `display: contents` by default,
so its children lay out as if they were direct `#app-bar` children, right in the single line,
contributing no box of their own. Below a `640px` viewport width, it instead becomes a real
box that opens as a dropdown under `#menu-bar-overflow-toggle`'s hamburger icon, rather than
sitting inline or forcing a second row: detaching it from the flow entirely, instead of
wrapping, is what keeps the bar a single line even here.

That dropdown is `position: fixed`, not `absolute`, with its `top` set from
`menuBarOverflowToggle`'s own click handler (`appBar.getBoundingClientRect().bottom`, plus a
small gap) rather than a CSS `top: 100%`. `#app-bar` has `overflow-x: auto` (so the icon row
itself can scroll rather than wrap on a truly tiny screen, per its own comment above) — and
per the CSS overflow spec, setting `overflow-x` to anything but `visible` silently forces
`overflow-y` to `auto` too. An absolutely-positioned dropdown's containing block would be
`#app-bar` itself (its sticky positioning context), which is *also* the clipping ancestor
under that forced `overflow-y: auto` — the dropdown would be clipped the instant it extended
past `#app-bar`'s own bottom edge, which is exactly what a dropdown does, and exactly what
made the hamburger menu appear to not work at all. `position: fixed`'s containing block is
the viewport instead, which `#app-bar`'s own overflow has no say over — at the cost of
needing an explicit `top`, which only JS (not a percentage in CSS) can express relative to
the viewport.

The `display: contents` switch and the dropdown's own positioning are CSS media-query rules
(`@media (max-width: 640px)`), not JS: nothing in `initSongbookApp` reads viewport width
itself, beyond the `top` calculation above. `menuBarOverflowToggle`'s click handler toggles an
`.open` class on `#menu-bar-overflow` (setting `top` only when opening); `showSong()` clears
that class on every song change so switching songs doesn't leave the menu open. This is purely
a narrow-viewport layout concern — the fake-DOM test suite can check the class toggle itself
but, per this file's own recurring caveat about that suite (§10), cannot verify the CSS
breakpoint actually looks right on a real phone.

**A setlist becomes the active browsing context once opened.** `getActivePlaylist()`
returns either every song (global browsing) or, when `currentSetlistIndex >= 0`, one
setlist's own entries in setlist order, each carrying its own transpose/capo override where
it has one, and never including an entry with no matching song. `showSong(position)` takes
a position in *whichever* of these is active, not a raw song index — next/previous and
their disabled state at either end are relative to that position. `currentSongIndex` (the
resolved index into the global `songs` array) is separate state, resolved once by
`showSong()`, so every other function that needs the actual song
(`renderCurrentSong`/`showPrintSong`/`saveCurrentSelection`/the key-capo change handlers)
reads it directly without knowing which playlist is active.

`backToCurrentList()` returns to the setlist a song was opened from, if any, otherwise the
global list — a setlist stays "the list" until the reader explicitly leaves it via
`#back-from-setlist-index-button` (setlist index → global list) or
`#back-from-setlist-button` (one setlist → setlist index).

Clicking a setlist entry that resolved to a song opens that song with the entry's own
transpose/capo override; the song view shows the **canonical song's own name**, never the
entry's own display heading (they can differ — SPEC.md §6/§7).

A non-exact match gets a small red `~` mark next to it, not a full warning box inline — a
specific, actionable message (e.g. "matches more than one song — make this entry's heading
more specific") lives in its `title` attribute, shown as a native tooltip on hover/focus,
rather than sitting in the row itself and dominating it. The only way to actually fix a
mismatch is editing the `.setlist.md` file and rebuilding the crate, since this page cannot
write back to the source folder (§2); the tooltip message says so. A deliberate, narrow
exception to colour otherwise being reserved for chord names (§14) — PT asked for this over
an earlier bordered-badge version specifically because it was too visually heavy.

Notes are hidable with one toggle for the whole setlist (`#toggle-notes-button` flips
`notesVisible` and re-renders every entry), not a control on every row.

## 12. Songbook HTML output — features

**Fit-to-window.** `fitTextToBox(element, availableHeight, availableWidth)` is a binary
search over font-size (`FIT_MIN_FONT_PX`–`FIT_MAX_FONT_PX`, 10–80px) that finds the largest
size at which `element.scrollHeight`/`scrollWidth` still fit the given box, used both
on-screen (`fitSongContent`, against the viewport minus the menu bar's height) and in print
(`fitPrintSongPage`, §13). There is no CSS-only way to do this: font-size determines how
much text wraps, which determines height, which is exactly what has to fit a box of known
height — `clamp()`/container query units size from the container's own dimensions, not from
how a given size makes a specific piece of text wrap. `fitSongContent` re-runs on window
resize/orientation change, debounced 150ms.

**Column count is part of the search.** The default is two columns when the available space is
wider than it is tall, otherwise one. But that rule knows nothing about the song, so
`fitSongContent` runs the font-size search at one, two and three columns
(`two-columns`/`three-columns` classes) and keeps the largest text, under two conditions. The
default is tried first and only loses to a count that beats it by `COLUMN_SWITCH_GAIN` (8%), so
the layout doesn't change for the sake of a pixel. And a candidate must not wrap lyric lines more
than the default does: `wrappedRowCount()` totals the extra rows lines take through wrapping (a
line on three rows counts two), because bigger text bought by chopping every line into pieces is
harder to play from, not easier. In practice songs with short lines gain a column (and up to a
third in size); songs with long lines keep the default.

**Tab blocks** (`<pre>`) scroll sideways inside their own box, so the search never sees one that
is too wide. Rather than hold the whole song's text down to what its widest tab allows,
`fitTabBlocks` shrinks only a tab that doesn't fit its column, by `clientWidth / scrollWidth` (its
padding is in em, so that factor is exact), down to half size; below that it scrolls. The inline
size is reset at the start of every fit.

**Vertical spacing is tighter on screen than in print**, since on screen all of it is paid for
in font size: `#song-content` has `line-height: 1.3` (the page's own is 1.5) and smaller margins
around headings and chorus/bridge blocks. Chords sit inline, not above the lyric, so lines don't
need the room.

**Title, key, capo.** `#song-header` — `#song-view-title`, `#key-select`/`#capo-select`
(`populateKeySelect`/`populateCapoSelect`) — is the first child of `#song-content`, not part
of `#app-bar`: `renderCurrentSong()` only ever overwrites `#song-pages`, `#song-content`'s
*other* child, so `#song-header` and the listeners bound to its selects survive every
re-render untouched. Living inside `#song-content` means it inherits whatever font-size
`fitSongContent` (§12) computes for the song itself — set in `em` there deliberately, not
`rem`, so title/key/capo scale up and down with the song rather than staying a fixed
toolbar size, clamped in both directions (below) so a very short or very long song can't push
the header to an absurd size — and participates in `#song-content`'s own column flow: CSS
multi-column
layout treats a container's children as one continuous flow regardless of how many there
are, so as the first content, `#song-header` lands at the top of the *left* column when
`.two-columns` is active, with no extra CSS needed for that placement beyond `break-inside:
avoid-column` (keeping title and key/capo together as one unit rather than letting the
column break fall between them).

Both selects are populated from a `ChordProSong` parsed fresh from the song's own `text` at
render time — via `parseSongForRender(song)`, not a bare `new ChordProSong(song.text)` (every
call site that renders or prints a song uses this). The difference matters once a key can come
from somewhere other than the file's own `{key:}` directive (§17): the song list's own key tag
reads `musicalKey` directly off the crate entity, so a guessed key already shows there
correctly, but a *fresh* parse of unchanged text — which is all `song.text` ever is, until a
human writes a guess back into the file itself (§17) — has no `{key:}` to find. Before
`parseSongForRender` existed this was a real, reported bug: the key showed correctly wherever
something read the crate directly, but `populateCapoSelect`'s own "N - (key shapes)" labels,
which need `parsedSong.key` specifically, fell into the no-key branch instead and showed bare
"Capo N". `parseSongForRender` fills `parsedSong.key` from the song's own `rawKey` (the crate's
resolved value) whenever the text itself has none, so every selector downstream —
`populateKeySelect`, `populateCapoSelect`, `renderSong`'s own `effectiveKey` — agrees with what
the list already shows, without needing the file to have been rewritten first.

**A key with no chords to transpose.** A chart can carry a `{key:}` purely as a reminder to the
performer — a reading/lyrics-only page, no chord brackets anywhere — in which case
`populateKeySelect`/`populateCapoSelect` both still return immediately on `!parsedSong.hasChords`
(there is nothing to transpose, so offering a dropdown that would do nothing is actively
misleading), but the key itself is worth keeping visible regardless: `#song-key-static`, a
plain `<span>` sitting where `#key-select` would otherwise go, shows `"Key: <value>"` as static
text whenever `parsedSong.key` is set and there are no chords, and stays hidden — same as
`#key-select` itself — when there's no key either. `#capo-select` gets no equivalent: a capo
choice without any chord shapes to apply it to has nothing left to mean.

`#song-header` is `flex-wrap: nowrap` — title, key, and capo always stay on one row, never
wrapping onto a second. What actually guarantees that fits is `fitSongHeaderTitle()`, called
at the end of `fitSongContent` once the song's own font-size (and, through it, key/capo's
own em-based widths) has settled: a binary search over `#song-view-title`'s own font-size,
the same idea as `fitTextToBox` but bounded by the *header's* leftover width (`#song-header`'s
own width minus whichever of `#key-select`/`#capo-select` are visible, minus a gap per
visible one) rather than the whole page.

Its search range is a flat `TITLE_MIN_FONT_PX`..`TITLE_MAX_FONT_PX` (16–36px), independent of
the body's own font-size — not, as an earlier version tried, a ceiling *derived* from it
(`min(TITLE_MAX_FONT_PX, max(TITLE_MIN_FONT_PX, bodyFontPx * 1.3))`, matching what a plain
`font-size: 1.3em` would give the title). That formula was meant only to stop a very short
song — whose body font-size can reach `FIT_MAX_FONT_PX` (80px) — from scaling the title up
into dominating the page, but a flat `TITLE_MAX_FONT_PX` ceiling already fully covers that case
on its own (`min(36, 80 * 1.3)` and a flat `36` are the same number), so the body-font term
added no benefit — and cost a real bug: for any normal-to-long song, whose body text has to
shrink well below `FIT_MAX_FONT_PX` to fit all its lyrics, `bodyFontPx * 1.3` could land
*below* `TITLE_MIN_FONT_PX`, at which point `max(TITLE_MIN_FONT_PX, ...)` pulled the ceiling
back up to exactly the floor — collapsing the search range to nothing and forcing the title to
16px regardless of how much header width was actually free. That fired for any song whose
*lyrics* needed a small font, which has nothing to do with whether the *title* had room — a
long song with a perfectly ordinary amount of header space would render with a visibly tiny
title next to a short song's much larger one, for no reason connected to the title's own fit.
`TITLE_MIN_FONT_PX` is a readable floor for a different reason: a title that can't fit even
this small, at the header's actual available width, ellipsis-truncates instead
(`#song-view-title`'s own `white-space`/`overflow`/`text-overflow`) — a readable-but-truncated
title beats a technically-whole but microscopic one. `fitTextToBox` gained two more optional
parameters for this, `maxFontPx`/`minFontPx` (defaulting to `FIT_MAX_FONT_PX`/`FIT_MIN_FONT_PX`
for its two original call sites, so their behaviour is unchanged).

**`#key-select`/`#capo-select` are also capped at `max-width: 5.5rem` (with `overflow:
hidden`/`text-overflow: ellipsis`)** — found via real (headless-Chrome) measurement, not the
fake-DOM test suite, which can't observe a real `<select>`'s own rendered width at all: Chrome
sizes a `<select>` by its *widest option*, not its currently-selected one.
`populateCapoSelect`'s own `"N - (key shapes)"` labels (§12, above) run noticeably longer for
any song with a real `{key}` — worse for a minor key, whose every option gets an extra
trailing "m" — than a keyless song's plain `"Capo N"` fallback. That difference alone could
reserve 50-90px more of `#song-header`'s width for a keyed song, at direct, otherwise-invisible
cost to `fitSongHeaderTitle`'s own available width — a keyed song's title could end up
noticeably smaller than a keyless one's for a reason with nothing to do with the title itself.
Capped via CSS rather than by shortening the label text — which stays fully intact and
readable in the open dropdown either way, only the *closed* box's width is bounded.

> **Keep in sync by hand:** `fitSongHeaderTitle`'s `SONG_HEADER_GAP_EM` constant
> (`songbook_html.js`, currently `0.6`) and `#song-header`'s own `gap: 0.6em` in the `<style>`
> block. `fitSongHeaderTitle` has no way to read the gap back out of the stylesheet — there's
> no `getComputedStyle()` available (the test suite's fake DOM has no equivalent, and a real
> browser would need a layout pass to resolve it) — so it keeps its own copy instead;
> changing one without the other means it reserves the wrong width for the gaps between
> title/key/capo.

Choosing a key only ever changes which note it is, never switches major to minor or back.
Choosing a key resets any capo choice to none. A song with no `{key}` directive gets a
`+0`..`+11` semitone-offset dropdown instead of note names. Both selects are hidden entirely
for a song with no chords at all (`ChordProSong.hasChords`). State
(`currentTranspose`/`currentCapo`) resets to the song's own values on every song change
unless a setlist entry override or a session-saved value (below) applies.

**Instrument and chord grids.** `#instrument-select` (also mirrored as
`#print-instrument-select` in the print banner — `setCurrentInstrument()` is the one place
`currentInstrument` is assigned, keeping both in sync) drives `#chord-diagrams`, a side
panel next to the song text populated per distinct chord `renderSong()`'s own `chordsUsed`
reports. `currentInstrument` is global for the whole session, not per-song. A chord with no
shape data for the chosen instrument is simply skipped (checked via
`diagram.strings.length`, a fresh `ChordDiagram` instance per chord).

**Session persistence.** Key/capo choices are saved to `sessionStorage` (not
`localStorage` — forgotten when the tab closes), keyed by song id
(`chordpro-songbook:key-capo`), wrapped in try/catch since `sessionStorage` access is known
to throw under `file://` in some browsers/privacy modes.

**Full screen.** `#fullscreen-button`, right after `#prev-song-button` in `#app-bar` (§11) —
a plain toggle against `document.documentElement.requestFullscreen()`/
`document.exitFullscreen()`. The glyph itself never changes (it's a fixed-size icon square,
shared with prev/next/print — §11); only `title`/`aria-label` ("Full screen"/"Exit full
screen") update, via the `fullscreenchange` event — setting the full text as `textContent`
on a box that small wraps and overflows it. Hidden in `@media print` alongside
`#print-banner`, since `#app-bar` stays mounted and un-hidden across every view (including
print) and would otherwise appear on the printed page itself.

**Hide/show chords.** `#toggle-chords-button`, in `#menu-bar-overflow` alongside
`#instrument-select`/`#print-song-button` — toggles the module-level `chordsHidden` flag and
a `chords-hidden` class on `#song-content`, which the stylesheet uses to hide every
`.inlineChord` span (`renderSong()`'s own chord-name markup). Global for the session like
`currentInstrument`, not reset per song. Scoped deliberately to the inline chord names in the
lyrics themselves, not `#chord-diagrams`: that panel is a separately opted-into feature (via
instrument selection), not something this toggle also suppresses. Print is unaffected — a
printed chart always shows its chords regardless of this on-screen preference, so the CSS
rule targets `#song-content.chords-hidden` specifically, never `#print-content`.

The button's own content is a fixed `[<span id="toggle-chords-glyph">C</span>]`, not a text
label — like `#fullscreen-button` (above), it's an icon among icons now, so only
`title`/`aria-label` change with state ("Hide chords"/"Show chords"); the visual state change
is the glyph's C striking through (a `.struck` class on `#toggle-chords-glyph`, driven by
`chordsHidden`) rather than any text swap.

**Song search.** `#song-search` filters `#song-list`'s rows by case-insensitive substring
match against the title *and* whatever `creditFor()` picked for that row's credit line (§12,
below) — composer, else performer, else subtitle, matching what's actually visible, not all
three independently regardless of which one a row displays. Implemented over
`Array.from(songListElement.children)`, not `.children.forEach` directly — a real element's
`.children` is a live `HTMLCollection`, which has no `.forEach` (unlike `NodeList`, which
does); the test suite's own fake DOM models `.children` as a plain array, which does have one,
so this exact mistake will pass every test here while doing nothing in a real browser.
`#song-list`/`#setlist-list` are both capped to `max-height: 60vh` with their own scroll,
rather than growing the whole page taller.

**Setlist search.** `#setlist-search`, in `#setlist-index-view`, filters `#setlist-list`'s
rows the same way — case-insensitive substring match against the setlist's own name, over
`Array.from(setlistListElement.children)` for the same `.children.forEach`-doesn't-exist
reason as `#song-search` above. A separate input from `#song-search`, since the two lists
(`#song-list`, `#setlist-list`) are never visible at the same time.

**Setlist-entries search.** `#setlist-entries-search`, in `#setlist-view` itself (not the
index of setlists — a third, separate input), filters one open setlist's own entry rows by
substring match against each row's own `searchText` — the same text the row displays (name,
credit, notes), stashed as a plain JS property on the row at build time
(`buildSetlistEntryRow`), not an attribute — nothing outside this file ever needs to read it
off real HTML. Not index-parallel with `setlist.entries` the way the two searches above are
with their own arrays: `#setlist-entries` intersperses "Set N" heading rows among the entry
rows (§6), so a row's position in the DOM doesn't line up with its position in
`setlist.entries` — `applySetlistEntriesFilter` reads each row's own stashed text instead of
re-deriving it from an index, and leaves a heading row alone entirely (identified by having
no `searchText` at all, rather than by its class name).

`applySetlistEntriesFilter` runs from two places, deliberately different in when they clear
the box first: `showSetlist(index)` clears `#setlist-entries-search` before rendering — a
leftover query from a previously-viewed setlist isn't assumed relevant to a new one, even
when "new" means re-opening the same setlist from the index. `renderSetlistEntries` itself
calls it again at the end of every render, `toggleNotesButton`'s own handler among them — that
one re-renders the *same* setlist's rows without going through `showSetlist` at all, and a
filter the reader just typed should survive that refresh rather than silently vanishing
because every row got rebuilt from scratch.

**Credit line and key in list rows.** Both `#song-list` (`showList()`) and `#setlist-entries`
(`renderSetlistEntries()`/`buildSetlistEntryRow()`) show, under each title, a single italic
credit line — `composer`, else `performer` (a song's own `{artist}`), else `subtitle`
(`{subtitle}`/`{st}`) — the first of those three the song actually has, never more than one at
once. This is a *display* preference for one line under a title, unrelated to and no more
authoritative than `chordpro_crate.js`'s own precedence for what a `{st:}` directive should be
migrated *to* (SPEC.md §15) — a song can perfectly well carry both a `composer` and a
`performer`, in which case only the composer shows here. The song's own `musicalKey` (`{key}`)
is shown alongside it, not italicized. A song with none of `composer`/`performer`/`subtitle`,
or no `{key}`, simply omits whichever part it has nothing for — nothing renders an empty
credit line or a bare "Key:" label.

A setlist entry (`buildSetlistEntryRow`) shows its *underlying song's* own credit/key this same
way, resolved via `entry.songIndex` into the `songs` array built at the top of
`initSongbookApp` — never anything of the entry's own, since an entry carries no
composer/performer/subtitle/key of its own to begin with (only `transpose`/`capo` overrides
and freeform notes — SPEC.md §6/§7). An unresolved entry (`entry.songIndex === -1`, no matching
song at all) shows neither, for the same reason it has no name link to a song view either.

**Same-titled songs in `#song-list`.** PT's own collection sometimes has two genuinely
different files that happen to share a title (a cover, an alternate arrangement, a rename
that missed one copy). When two or more songs in the (alphabetically sorted) list share the
exact same `name`, each of *those* rows — not every row — also gets a small italic path line
underneath, showing that song's own `@id` (its relative path, SPEC.md §7), the same
"path disambiguates same-named things" convention §16's own match-review tiles use for
candidate songs. A uniquely-titled song shows no path line, same as before this existed. Purely
a display aid — the path line isn't itself a link, and `#song-search` is unaffected (it already
matches title/credit text, not a song's own file path).

**Flattening the set hierarchy for display (SPEC.md §6).** The crate's own set/sub-playlist
entities exist for the data model, not because `renderSetlistEntries()` needs to walk a tree
to render one: `flattenSetlistParts()` turns one setlist's own `hasPart` — a mix of direct
entry references and nested "# Set" sub-playlist references, in file order — into the same
flat array of entries the rest of this file already expected before that hierarchy existed
(`getActivePlaylist()`, `showPrintSetlist()`, and `renderSetlistEntries()` itself are all
unchanged), attaching `setName`/`setNotes` to each entry fresh as it flattens rather than
mutating any shared object. A set's own note (its `text`, SPEC.md §6/§6.2) is attached only
to the *first* entry in that set, so a single pass through the flattened array renders it
exactly once — as a `.setlist-set-notes` element, right after that set's own "Set N" heading
and before its first entry row, the same place `renderSetlistEntries()` already inserts the
heading itself. It carries no `searchText` of its own, so "Find in this setlist"
(`applySetlistEntriesFilter`) leaves it shown regardless of the query, the same as the heading
above it.

Distinguishing a *top-level* setlist from a nested "# Set" sub-playlist — both share the one
`MusicPlaylist` type (SPEC.md §7) — is done by `@id` shape, not a separate flag: a set's own
`@id` is always `<setlist path>#set-N` (chordpro_crate.js's own convention), which a real
setlist file's own path can never look like. `#setlist-list` (the top-level index, §11) is
built only from `MusicPlaylist` entities whose `@id` contains no `"#"` — a nested set is only
ever reached by walking a real setlist's own `hasPart`, never listed as an entry in its own
right.

## 13. Songbook HTML output — print

`#print-view` replaces the whole screen rather than opening `window.open()` in a new
window — `window.open()` is blocked or silently does nothing in some contexts this
standalone page may be opened from (SharePoint, Dropbox's own preview); `window.print()`
itself prints whatever the *current* window shows, so no popup is needed. `#done-printing-button`
is a small "×" close button fixed to `#print-view`'s own top-right corner (`position: absolute`),
not one more inline text button competing for space in the banner's row of other controls below
it — PT: "more like a window / modal close button." The on-screen banner (hidden in
`@media print`, along with the close button itself) tells the reader to press Escape or click it
to return to the app; `exitPrintView()` returns to whichever of a song, a setlist, or the global
list was open beforehand.

Three entry points, each setting `currentPrintRebuild` (re-invocable with no arguments, so
changing the instrument mid-preview via `#print-instrument-select` redraws the same job) and
each showing/hiding the banner's own controls to match what actually applies to it:

- `showPrintSong()` — the one song currently open, `#print-song-button` (menu bar). No front
  matter, facing-page alignment, or floor sheet makes sense for one standalone song, so
  `#include-toc-label`/`#facing-pages-label`/`#floor-sheet-label` (and its own
  `#floor-sheet-notes-label`) all stay hidden; large print and instrument selection still apply.
- `showPrintBook()` — every song, `#print-book-button` (list view), each in its own key/capo
  rather than whatever's selected on screen. Floor sheet is a setlist-only mode (below), so its
  two labels stay hidden; every other control applies.
- `showPrintSetlist(index)` — one setlist's own entries in setlist order,
  `#print-setlist-button` (setlist view), each in that entry's own transpose/capo override.
  An entry with no matching song has no page to print, so it's skipped from the song pages,
  but stays on the contents page with "—" in place of a page number. The one entry point where
  `#floor-sheet-label` shows at all — ticking `#floor-sheet-checkbox` switches it over to the
  alternative layout described under "Floor sheets" below, hiding
  `#include-toc-label`/`#large-print-label`/`#facing-pages-label`/`#print-instrument-select` for
  as long as it's ticked, since none of them mean anything for a page with no chords or lyrics
  on it at all.

**Title page and contents, optional.** `#include-toc-checkbox` in the print banner — checked by
default (the markup's own `checked` attribute) — gates whether `showPrintBook`/
`showPrintSetlist` call `buildFrontMatterPages` (below) at all. Unticked, every song's own page
numbering just starts from page 1 instead of after the front matter
(`1 + (includeToc ? frontMatterPageCount(...) : 0)`, in both functions) — for a reader printing
a short set who doesn't want a title/contents page ahead of it. `showPrintSong()` never shows
this control: a standalone single-song print has no book/contents page to include or omit in
the first place, the same reasoning as it having no page number either (below).

**Page layout.** Each of a song's own sections (`renderSong()`'s own `pages` array — length 1
unless the source has `{new_page}`/`{np}` directives, in which case one A4 page per section:
`buildNormalPrintSongPages`, not a change to `buildSongPrintPage` itself, which still only
ever builds one page from one section) is fitted onto exactly one A4 page via
`fitPrintSongPage` (§12's `fitTextToBox`, against a fixed A4-sized box instead of the
viewport) — not clipped. None of these per-section pages carry a "(continued)" note: unlike
large print's own auto-split continuation (below), a `{new_page}` break is a deliberate,
authored one, and every section starts clean. `.print-page`'s physical A4 sizing (width,
padding) is applied unconditionally, **not** confined to `@media print`, so `fitPrintSongPage`
can measure and fit against the page's real size immediately, before the reader ever asks to
print; a size that only existed once print CSS took effect would be invisible to JS run
beforehand. `@media print` itself only adds `page-break-after`, hides the on-screen
banner/fullscreen button, and zeroes `@page` margins.

> **Keep in sync by hand:** `PRINT_PAGE_PADDING_MM` (`songbook_html.js`, currently `10`) and
> the `.print-page { padding: ... }` value in the `<style>` block must match exactly. They
> can't share one source value — one lives inside `initSongbookApp`'s own embedded-via-
> `.toString()` function body, the other in a separate template string in
> `renderSongbookHtml` — so changing one without the other silently breaks
> `fitPrintSongPage`'s available-space calculation.

**Front matter.** `buildFrontMatterPages(titleText, entries)` produces the title + contents
page(s) — skipped entirely when `#include-toc-checkbox` is unticked (above): one combined page
(title, an optional "With chords for [instrument]" subtitle when
one is selected, and the contents list) for up to `TOC_SPLIT_THRESHOLD` (50) entries; above
that, the contents list splits into `Math.ceil(entryCount / TOC_ENTRIES_PER_PAGE)` pages of
`TOC_ENTRIES_PER_PAGE` (50) entries each, headed "Contents (i/N)", title/subtitle only on
the first. `frontMatterPageCount(entryCount)` computes the same page count independently,
since every song's own page number has to be known before any page is actually built.

**Page numbers.** Every page — front matter or song — carries its own number
(`.print-page-number`, absolutely positioned in a corner, so it never affects
`fitPrintSongPage`'s own height measurement). `showPrintSong()` (no book context) omits one.

**Chord grids in print.** `buildChordDiagramElements()` (the same logic the on-screen
`#chord-diagrams` panel uses) is called by `buildSongPrintPage` too, laid out as a side
panel next to the song text — its width comes out of the song body's own `clientWidth` once
laid out, so `fitPrintSongPage` doesn't need to subtract it. A song that actually got at
least one diagram also gets a small "Chords for [instrument]" note under its own title
(`.print-chords-for-note`), independent of whether the book-level subtitle is showing, since
not every song is guaranteed a shape for every chord it uses; both notes' rendered heights
are subtracted from `fitPrintSongPage`'s own budget.

**Large print.** `#large-print-checkbox` in the print banner — checked, every song gets two
physical pages instead of one, at a font size roughly double what `fitPrintSongPage` would
have found for the same content on a single page. Read directly wherever it matters
(`largePrintCheckbox.checked`, in `showPrintSong`/`showPrintBook`/`showPrintSetlist`) rather
than kept in a separate synced variable — there's only the one checkbox, and its own checked
state is unaffected by `#print-view` being hidden/shown, so there's nothing to restore on
re-entry either (unlike `currentInstrument`, which two different selects need kept in sync).
Changing it while already in print view redraws via `currentPrintRebuild`, the same as
changing the instrument does.

*Building the spread.* `buildLargePrintSongPages(name, rendered, firstPageNumber)` builds
two-page pairs, one pair per section in `rendered.pages` — almost always length 1, but not
when the source has its own `{new_page}`/`{np}` directives (chordprobook's `renderSong`,
which splits on exactly that); normal print mode joins every section into one continuous flow
on one page regardless (`buildSongPrintPage`'s own `body.innerHTML =
rendered.pages.join("\n")`), but large print gives each section its own independent spread,
each with its own font-size fit and its own split point.

Page 1 of a pair is built with the section's full rendered content, the same as a normal
print page; page 2 is built with none of its own (`{ ...sectionRendered, pages: [""] }`).
`fitLargePrintSongPages(page1, page2)` is what moves whatever doesn't fit on page 1 onto page
2 — and, unlike every other fit in this file, can't just reuse `fitTextToBox`: that fits one
box to one height; this has to fit one piece of content across *two* independently-sized
boxes (page 1's own `availableHeight1`, page 2's own `availableHeight2` — usually close but
not identical, since page 2 alone carries a "(continued)" note) and, more importantly, has to
choose *where* to split it.

Two earlier versions of this got the split itself wrong, in different ways. The first cut at
an arbitrary height (the midpoint of a box fit to twice one page's height) — landing mid-line
or mid-chorus, visually chopping a heading or lyric in half across the page break. The second
fixed *where* to cut (walking children to find a clean boundary, below) but still built page 2
as a *second*, separate rendering of the identical markup, relying on a computed clip+negative-
margin to make it show "the other half" — which depends on that second copy reflowing
pixel-for-pixel identically to the first one's independent layout; small divergences between
them chopped text right at the seam regardless of how carefully the boundary was chosen, and
any section whose content didn't fit within the *combined* two-page budget overflowed
invisibly past page 2's own clip, forcing the browser to insert its own extra, untracked
physical page with no page number and no "(continued)" note — breaking the odd/even alignment
(below) for every song after it.

The current version avoids both by moving the actual DOM nodes instead of measuring a height
to clip. `trySplit(fontPx)` walks `.print-song-body-content`'s top-level children (`renderSong()`'s
own `.heading`/`.line`/`blockquote`/`pre`/`img` chunks) and finds the largest prefix that fits
within `availableHeight1` without cutting one in half — a whole `blockquote` (chorus/bridge:
several lines wrapped in one element) moves to page 2 entirely rather than being split
mid-block, which is the case that most obviously exposed a bad cut. It uses each child's own
`offsetTop` (not a running sum of `offsetHeight`, which would silently drift from the real
rendered layout once margins between adjacent siblings collapse) to find that boundary, and
checks that everything after it still fits within `availableHeight2` (`remaining <=
availableHeight2`) before accepting a given font size — the search itself is over font size
exactly like `fitTextToBox` (same `FIT_MIN_FONT_PX`/`FIT_MAX_FONT_PX` bounds), just with this
two-sided `fits` check standing in for `fitTextToBox`'s own single-box comparison. Once the
search settles on a font size and a cut index, the actual children from that index onward are
moved — `page2.printSongBodyContent.appendChild(child)` for each — directly off page 1's own
(real, already-measured) content onto page 2's. Neither page's `.print-song-body` needs an
explicit height or `overflow: hidden` at all: page 1 only ever keeps the children just proven
to fit its own budget, and page 2 only ever receives the ones proven to fit its own — there's
nothing left over on either side to clip, and (short of a single section too long to fit two
pages combined at any font size down to the floor — the same accepted edge case
`fitTextToBox` already has for a single page, not new here) nothing left to silently overflow
onto an untracked extra page either.

Building page 2 by moving nodes rather than duplicating markup and clipping it — and not one
wide multi-column box spanning two sheets, an idea considered and discarded before any of
this was written — avoids the fragility of two independently-laid-out copies needing to agree
pixel-for-pixel, and the unreliability of CSS multi-column fragmentation across physical
printed pages (columns distribute across a page's own overflow height, not sideways across a
page *width* wider than the paper itself, which is what two side-by-side pages would need).
The second page of every pair carries a small "(continued)" note (`buildSongPrintPage`'s own
`continued` parameter) so a page landing on its own — photocopied, separated from its spread —
still reads as the back half of a longer song rather than a different, truncated one; a fresh
`{new_page}` section deliberately does *not* get this treatment on its own first page, since
it's meant to start clean.

> **Test coverage gap:** `trySplit`'s own boundary-walking (never cutting a child element in
> half, and the node move that follows it) isn't exercised by `test-songbook-html.mjs`'s fake
> DOM — its `document.createElement` never populates a real `.children` tree from an
> `.innerHTML` string (this file's own header comment), so every dynamically-built print
> page's `.print-song-body-content.children` is always empty in a test, regardless of what
> was assigned to `.innerHTML`. With no children to walk, there's nothing to move either —
> `test-songbook-html.mjs`'s own large-print tests assert exactly that (both pages'
> `.children` staying empty), with a comment pointing back here rather than re-explaining it.
> Confirming the boundary-walking itself avoids a bad cut, and that nothing overflows onto an
> untracked page, is a real-browser concern, same as this file's other layout caveats (§10,
> §11).

*Facing-page alignment.* `#facing-pages-checkbox` in the print banner, checked by default (the
markup's own `checked` attribute, not JS) — PT: "keep songs on facing pages for double-sided
printing." `alignSongStart(pageNumber, pageCount, keepFacingPages)` decides, for *every* song
in sequence (`showPrintBook`/`showPrintSetlist`'s own running `pageNumber`), whether a blank
filler page has to go immediately in front of it: an even page and the odd page immediately
after it are what a reader actually sees together when a bound book is opened (page 1 is
always alone, on the right); an odd-then-even pair never is, since it straddles two different
spreads instead of forming one. A single-page song is skipped entirely regardless of the
checkbox — there's no spread to protect, so aligning it would just scatter blank pages through
the book for no benefit — and unchecking the box skips every song, including multi-page ones.
When a blank page is needed, `buildBlankPrintPage()` (explicitly marked "This page is
intentionally blank" — the same convention real printed books use, so it doesn't read as a
mistake) is inserted, and the song's own first page moves from `pageNumber` to `pageNumber +
1`.

This has to be a per-song check, not a once-per-book one, because normal print's own per-song
page count varies now — a `{new_page}` song (`buildNormalPrintSongPages`, above) can be any
length, so *any* song along the way, not only the first, can land on an odd start after an
earlier odd-length one (Song A, one page; Song B, two — Song B's own start is what needs
checking, not the book's). Large print doesn't have this per-song variability (every song is
always exactly two pages, or two pages per `{new_page}` section —
`buildLargePrintSongPages`), so in practice `alignSongStart` only ever inserts a blank there
for the first song in the whole book; every later one is already aligned automatically, since
an even page count added to an even start always lands on another even number — but the check
itself doesn't need to know that distinction; it re-verifies before every song regardless.

**Floor sheets.** `#floor-sheet-checkbox`, setlist print only (`showPrintSetlist`) — PT: "just
lists songs old skool style for putting at your feet while you play." A wholly separate,
much simpler page-building path (`buildFloorSheetPages`/`buildFloorSheetPage`/
`fitFloorSheetPage`), not a variant of the book-style layout above: no chords, no lyrics, just
each entry's own name in a numbered list — which is also why large print, facing-page
alignment, instrument selection, and the TOC checkbox are all hidden for as long as it's ticked
(above), rather than merely ignored while doing nothing.

Entries are grouped by the same consecutive-setName-run idea `groupEntriesIntoSets`
(`chordpro_crate.js`) already uses to build the nested-`MusicPlaylist` hierarchy in the first
place (`groupSetlistEntriesForFloorSheet`): entries sharing a setName with the one right before
them land on the same page; a changed or absent setName starts a new one. A setlist using no
"#" sets at all becomes a single page, headed by the setlist's own name; one that does use sets
gets one page per set, each headed by that set's own name, plus — if the setlist mixes in
entries before its first "#" heading — one further page for just those, headed by the setlist's
own name in place of a set name it doesn't have.

Unlike every other print path in this file, an entry with no matching song
(`entry.songIndex === -1`) still gets a line here: there's no *page* to build for a song that
isn't there, but nothing stops a plain name being listed old-school-style, and the same
reasoning that keeps an unresolved entry on the normal contents page (above, "—" in place of a
page number) applies just as much here — silently dropping it would hide the exact mismatch
this whole feature exists to surface.

`#floor-sheet-notes-checkbox` — its own label shown only while floor sheet mode itself is
ticked, checked by default — adds each entry's own note underneath its name, via the same
`renderNoteMarkdown` the on-screen setlist view and note modal already use (§6.2); there's no
separate print-only note renderer.

Each page is fitted to one A4 sheet the same way a normal song page is
(`fitFloorSheetPage`/`fitTextToBox`, against the page's own list element) — the heading stays
whatever size it renders at; only the list (names, plus any notes) scales down once a set has
enough entries, or long enough notes, to need it. No page numbers, same reasoning as
`showPrintSong()`'s own standalone print: there's no book/contents page for one to refer back to.

## 14. Visual design

High contrast: plain black-on-white (white-on-black under `prefers-color-scheme: dark`).
On screen, chords are shown without their `[]` (`renderSong`'s `noBrackets`) — the colour
already sets them apart — as inline blocks with a little padding, so a mid-word chord doesn't
split its word; the print views keep the brackets, since a printout may be black and white. A
blank line in a song's source (the gap between verses) shows as a gap of half a line (0.6em
plus its margin), in the song view and in print; consecutive blank lines collapse to one, and
one at the very start or end of a block, or next to anything that isn't a lyric line (a heading,
a chorus/bridge block, a tab block — all of which have margins of their own), is dropped. Chord names are red on white and, on screen in dark mode, yellow on black
(`@media screen and (prefers-color-scheme: dark)` — screen only, so printing from a dark-mode
browser still gives red chords). **That colour (`--chord`) is otherwise reserved for chord names** — every other control (buttons,
borders, the menu bar) uses black/white rather than a colour of its own. The one deliberate
exception is a setlist entry's `~` match-status mark (§11), which follows `--chord` — PT asked for red there
specifically, over an earlier bordered-badge version — so red now means two things instead of
one, though the two never appear in the same view, which keeps the practical ambiguity low.
Chorus/bridge passages and tab blocks are set off by a border rule, never a background tint —
no filled panel sits behind any text anywhere on the page. Song text is serif; UI chrome
(buttons, the menu bar) is a plain sans.

**Not yet built:** a hide-chords toggle, Nashville-number display, or any further style
controls beyond what's listed in §12.

## 15. Metadata entry and cleanup — the `{st:}` cleanup tool

PT's own ChordPro chart collection goes back to around 2015, predating this project's own
`{artist}`/`{subtitle}` split (§5): a lot of charts use `{st: ...}` where the value is
actually a performer or composer credit, not a genuine subtitle. This tool finds those
occurrences and rewrites them under a human's own per-occurrence choice — it never guesses.

**Not part of a build.** This tool runs on request from the app's result card (§3): the
"old `{st:}` credits" check runs `findStDirectiveHits` after every build and, if there are
any, offers "Fix credits…" (`fixStDirectives`, `fix_st_directive_action.js`). Since it
rewrites song files, the app runs "Make songbook" again once it has applied anything, so the
new credits reach the crate and the songbook.

**Status.** `st_directive.js` (the shared, isomorphic matching/rewrite core) and
`scripts/fix-st-directive.mjs` (the Node CLI, run by hand — see `package.json`'s own
`fix:st-directive` script) are both implemented and tested in this repo, exactly as described
below. `fix_st_directive_ui.js` (the browser-only shell around that same core) and
`fix_st_directive_action.js` (the modal around it) are also implemented, but have no
automated test of their own (thin File System Access API/DOM shells; exercising them needs a
real browser, same caveat as this project's other browser-only code).

**Shared, isomorphic core.** `st_directive.js` is pure string-in/string-out logic — no file
I/O — reused as-is by both `scripts/fix-st-directive.mjs` (the original, Node CLI
version of this tool, run by hand against a real chart collection) and
`fix_st_directive_ui.js` (the browser shell below), so the actual `{st:}`-matching and
rewrite rules exist exactly once. It exports:
- `ST_DIRECTIVE_RE` — matches `{st: value}` (whitespace-tolerant, case-insensitive on `st`
  itself), deliberately not matching `{subtitle:}`/`{artist:}` (already-correct directives)
  or `{start_of_chorus:}`/`{stanza:}` (the colon has to immediately follow `st`).
- `findMatches(text)` — every occurrence in one file's text, in document order, as
  `{ value, matchText, index }`.
- `applyChoices(text, choices)` — `choices[i]` is the choice for the *i*-th match
  `findMatches()` would return, in that same order: `"artist"` (default, `{st:}` becomes
  `{artist:}`), `"composer"` (replaces the line with `{composer:}` instead — it was never a
  performer credit), `"both"` (keeps the renamed `{artist:}` line and adds a *second*, new
  `{composer:}` line after it), or `"skip"` (the original `{st:}` line is left untouched).

Both functions defensively reset `ST_DIRECTIVE_RE.lastIndex = 0` before scanning:
`String.prototype.matchAll` on a shared, mutable, global (`/gi`) regex inherits whatever
`lastIndex` the regex object was last left at rather than always starting from 0 — a real
correctness hazard for an exported, reusable regex — even though `String.prototype.replace`
happens to reset it internally regardless.

**The CLI script's own interactive UX is unchanged by sharing this module.** `scripts/fix-
st-directive.mjs` still does its own thing end to end: list every hit numbered, ask which
numbers should *also* get a `{composer:}` line (its `doubleUpNumbers` set becomes a
per-file `choices` array of mostly `"artist"`, `"both"` for the flagged ones), confirm, zip
the affected files, rewrite. `"composer"`-only and `"skip"` are choices the shared module
supports but the CLI's own prompt never offers — nothing about the CLI's UX asked for them.

**The browser UI (`fix_st_directive_ui.js`)** owns the one File System Access API walk this
tool needs, independent of `chordpro_crate.js`'s own (reusing its exported
`DEFAULT_SONG_EXTENSIONS` so both walks agree on what counts as a song file):
- `findStDirectiveHits(dirHandle)` — walks the folder, returning one flat, globally-numbered
  list of hits (`{ number, relativePath, lineNumber, value, matchText }`) across every song
  file, in a stable sorted-file order and each file's own document order.
- `applyStDirectiveFixes(dirHandle, hits, choicesByNumber)` — re-reads each affected file
  fresh off disk (not trusting whatever `findStDirectiveHits()` saw, which may be from
  moments earlier), zips the original text of every affected file — not every file scanned,
  which would bulk out the backup with files that have nothing to do with this cleanup —
  writes that zip to `.chordpro-cleanup-backups/<timestamp>.zip` *inside* the picked folder
  via `writeFileAtPath` (`fs_helpers.js`, which creates intermediate directories as needed),
  then rewrites each affected file in place via `applyChoices`.

**Why the backup stays out of a crate build with no new code.** A dot-prefixed folder is
already invisible to every folder walk in this codebase — `chordpro_crate.js`'s and
`fix_st_directive_ui.js`'s own `isIgnoredName` both unconditionally skip anything starting
with `.` — so `.chordpro-cleanup-backups/` needs no entry in `GENERATED_FILENAMES`/
`CONTROL_FILENAMES` (`chordpro_crate.js`) to stay out of the crate.

**The UI itself**: "Fix credits…" re-scans the folder (if there are no hits, a one-line
"nothing to fix" message goes to the log instead of opening anything), then opens a modal via
`openModal` listing every hit (file path, line, matched value) each with a `<select>` —
Artist / Composer / Both / Leave as `{st:}` — defaulting to Artist, using the app's generic
`.mapping-head`/`.mapping-row` classes (`app/app.css`). "Apply" reads every row's choice,
calls `applyStDirectiveFixes`, and logs a result summary (files changed, occurrences, backup
path); "Cancel" changes nothing. `fixStDirectives` resolves to whether any file was
rewritten, which is what triggers the rebuild.

## 16. Resolving ambiguous setlist matches

**Status:** the data-side logic below (`rankCandidatesByPath`, `findAmbiguousSetlistMatches`,
`extractReviewableSetlistMatches`, persisted-choice reuse, all in `chordpro_crate.js`) is fully
implemented and covered by `test-chordpro-crate.mjs`. The UI is `setlist_match_action.js`:
`resolveSetlistMatches` (the pre-build soft gate) and `reviewSetlistMatches` (the result
card's "Review setlist matches…" button, §3), both building their modal bodies inside the
app's `openModal`.

`matchEntryToSong` (chordprobook, §6.1) can only report *that* an entry matched more than one
song — it has no notion of file paths at all, so it has no principled way to prefer one
candidate over another and just picks the first it happened to find. `chordpro_crate.js`, which
does know every candidate's own path, replaces that placeholder pick with a **path-proximity
default** and, when the picked-for-you default might be wrong, lets a human confirm or
override it — a step that runs between scanning the folder and actually building the crate,
not inside `matchEntryToSong`
itself (which stays a plain, path-blind chordprobook function, unchanged, for every other
consumer of that library).

**Path-proximity ranking.** `rankCandidatesByPath(setlistPath, candidates)`
(`chordpro_crate.js`) ranks a set of candidate songs by how many leading directory segments
they share with the setlist file itself — `gigs/friday/gig.setlist.md` and
`gigs/friday/SongA.cho.txt` share two segments (`gigs`, `friday`); `songs/rock/SongA.cho.txt`
shares none. More shared leading segments ranks first ("closest in the tree", PT's own
phrasing); the filename itself never counts, only the directories above it. Candidates that
tie on shared-segment count keep whatever relative order `matchEntryToSong` already returned
them in (a stable sort, not a second, arbitrary tiebreak of this feature's own invention) —
today that's chordprobook's own scan order, the same order ties would already have resolved to
before this feature existed. This ranking decides two things, always together: which candidate
`specializationOf` actually points to (§6.1, unless a human override says otherwise — below),
and the order `custom:matchCandidates` itself lists them in (§7) — the crate's own data and
the review UI's own default selection can never disagree about which candidate is "closest".

**The review step (soft gate).** Clicking "Make songbook" (§3) first awaits
`resolveSetlistMatches`, which runs a lightweight pre-scan of the folder
(`findAmbiguousSetlistMatches`, (reusing the same file-walking/parsing/matching `buildCrateFromChordProFolder` (§4)
itself uses, factored out so this scan doesn't have to build a full, throwaway crate just to
find out which entries are ambiguous) *before* `buildSongbook` actually builds one. Every entry whose `matchStatus` would come out `"ambiguous"`, across every setlist
file in the folder, is a candidate for review — unless a **persisted choice** already resolves
it (below), in which case it's silently excluded, no prompt needed. If nothing remains after
that filter — the overwhelmingly common case, once a collection's ambiguities have been reviewed
once — the build proceeds immediately with no modal at all.

Otherwise the review modal opens automatically, one tile per still-outstanding ambiguous
entry (below), each pre-selected to its own path-proximity default. This is a **soft** gate,
not a hard one: a single "Build" button (the modal's only real exit, always available, always
enabled) reads whatever's currently selected — reviewed or still sitting on its default — for
every tile and proceeds straight into the actual build (`resolveSetlistMatches` resolves to
the `matchOverrides` object `buildSongbook` takes). The modal's "×" close icon (and Escape, or a
backdrop click — `openModal`'s `onDismiss`) is exactly equivalent to clicking
"Build" without touching anything — a fast way out for a reader who glances at the tiles, is
happy with every default, and doesn't want to click a radio button on each one. Neither control
cancels the build itself — there's no path through this modal that *doesn't* end in a build,
since the underlying defaults are always a sane, buildable choice on their own; reviewing is
optional polish on top of them, not a precondition for anything to work at all.

**The tile UI.** One card ("tile", `.csm-match-tile`) per entry, modelled on the songbook
page's own setlist-entry rows, not a fresh design — a reader
who's already used the setlist view (§6.2, §11) should recognise the shape immediately:
- **Title**: the entry's own heading text (`entry.rawHeading`) — e.g. "Amazing".
- **Context** (small, muted, underneath the title): which setlist file this entry came from,
  and which "#" set if it's inside one — e.g. "gig.setlist.md — Set 1", or just
  "gig.setlist.md" for an entry outside any set — so reviewing many ambiguous entries from
  across a whole folder at once doesn't require guessing which gig each one belongs to.
- **Candidates**, one radio button each, in path-proximity order (closest first): the
  candidate's own title, with a small italic path line underneath showing its `@id` (relative
  path) — the exact same "path disambiguates same-named things" convention §12's own
  same-titled-songs note uses in `#song-list`, reused here rather than invented twice. The
  closest candidate's own radio starts checked.

**Persisting choices.** A human's own pick, once made, should not have to be re-made on every
later rebuild of the same folder — but there's no separate database to remember it in, and
there doesn't need to be one: it's simply written into the crate itself, as that entry's own
`specializationOf`, the same as any other resolved match (§6.1, §7). The next time this
pre-scan step runs against the same folder, if `ro-crate-metadata.json` already exists there,
it's read once up front (`extractPersistedSetlistMatches`). For each freshly-found ambiguous entry, a prior entity is looked up by *content*, not
position — same setlist file, same `name` (raw heading text) — never by comparing
`#entry-N`-style `@id`s directly, since those are positional and shift the moment an entry is
added, removed, or reordered anywhere earlier in the same file (the same reasoning already
documented for why `setNotes` and `groupEntriesIntoSets` key by name rather than index, §6). If
a matching prior entity exists, *and* its own `specializationOf` still points at a song that
(a) still exists among this run's freshly-harvested songs and (b) is still among this entry's
current candidate set, that prior choice is reused silently — this run never re-derives a
"default" for it at all, path-proximity or otherwise, since a human already decided. Anything
else — no prior entity, the setlist file is new, or the previously-chosen song's own file is
gone or no longer a candidate — falls through to needing review, defaulting to the
path-proximity pick like any other fresh ambiguity.

**Why a stale persisted choice can't silently linger.** `buildCrateFromChordProFolder` already
rebuilds every entity fresh from a live folder scan on every run (§4, §8) — a song or setlist
file that's been deleted since the last build simply isn't regenerated; there is no merge step
that could accidentally keep its entity alive. The *only* place any state from a previous
build ever carries forward into a new one at all is the persisted-choice lookup just above, so
that's the one place a dangling reference to a deleted file could actually enter the picture —
guarded, as described, by checking the chosen candidate still exists among the current scan's
own songs before ever trusting it. When that guard rejects a persisted choice specifically
because the file it pointed to is gone (as opposed to simply never having had one), a build-log
line says so by name — e.g. "Discarded a previously-resolved match for 'Amazing' in
gig.setlist.md — the song it pointed to no longer exists; please re-resolve" — so a reader
sees *why* an entry they thought they'd already handled is back in the review modal, rather
than silently wondering. The CLI (§10) applies the same reuse but never prompts: whatever isn't
resolved by a persisted choice gets the path-proximity default.

**Test coverage.** `rankCandidatesByPath` and the persisted-choice lookup are plain,
path-in/path-out logic — testable in Node against a dummy folder tree (`test-chordpro-crate.mjs`)
without a real File System Access API or a fake DOM: a handful of same-titled songs at
different depths and in different branches of a small tree, a few setlist files scattered
around that tree (some near their intended match, some far from it), and — for the ambiguous
case specifically — two candidates placed at equal depth to confirm the tie stays in scan
order rather than being re-sorted some other way. The persisted-choice path gets its own
fixture pair: a "prior" crate JSON with an already-resolved ambiguous entry, rebuilt once
with every candidate file still present (choice reused silently) and once with the previously-
chosen file deleted from the dummy tree first (choice discarded, entry falls back to the
path-proximity default, and the "discarded" build-log line fires).

### Reviewing already-built matches

The pre-build review above only ever surfaces an entry once — a choice, once made (fresh or
persisted), is baked into the crate and won't come up again on a later rebuild unless its own
ambiguity genuinely changes (a new candidate appears, or the chosen file disappears). That's
the right behaviour for *rebuilding*, but it leaves a real gap: a reader who only notices a
wrong match after actually looking at the built songbook has no way back into that one
decision. **"Review setlist matches…"** (`reviewSetlistMatches`, offered in the result card's
checks whenever the crate has any entry that was ever ambiguous, §3) is that way back — a
second, independent entry point into the same tile UI, this time reading whatever's already on
disk rather than doing a fresh folder scan, and open to *every* entry that was ever ambiguous,
not only ones still "unresolved".

**Reading and patching, not rebuilding.** `extractReviewableSetlistMatches(crateJson)`
(`chordpro_crate.js`) walks a crate already read off disk for every entry carrying
`custom:matchCandidates` at all (an entry that was *ever* ambiguous, resolved or not — the
opposite filter from `findAmbiguousSetlistMatches`'s pre-build scan, which only ever surfaces
what's still outstanding), and returns, per entry: `currentId` (whatever `specializationOf`
already points to), `recommendedId` (`rankCandidatesByPath`'s own independent answer, ignoring
what was actually chosen), and the full candidate list. Since the crate has no property
recording *which* setlist/set an entry belongs to (that's structural — a set or setlist's own
`hasPart`, SPEC.md §6/§7) this has to walk every `MusicPlaylist` entity's own `hasPart` once to
build an entry → {setlist, set} lookup — `findAmbiguousSetlistMatches` never needs this, since
it gets `entry.setName` for free from `parseSetlist` itself.

Clicking the button reads `ro-crate-metadata.json` fresh, and — if `extractReviewableSetlistMatches`
returns anything — opens the review modal again (`openReviewModal`), the exact
same tiles as the pre-build review (`renderTiles`, shared by both), just with two
differences: each tile's radio starts on `currentId`, not the closest candidate, and whichever
candidate *is* `recommendedId` gets a small "closest" badge next to it — so a reviewer sees, at
a glance, both what's actually chosen and what the app would have recommended, which usually
but not always agree. On "Save", `specializationOf` is patched directly on whichever entries
actually changed, and `writeOutputs` rewrites the crate and re-renders the songbook (a pure
function of the crate JSON, §10) — without re-walking the source folder or rebuilding. No song
file changes, so the app just refreshes the result card.

**A real cancel exists here, unlike the pre-build modal.** The pre-build review is a soft gate
with no wrong outcome — even every tile left on its own default is still a sane thing to build
with, so its own × close icon is just a shortcut for "Build" (§16's own "soft gate" section,
above). This modal is different: opening it and closing it without meaning to shouldn't
silently rewrite a crate for no reason, so its × (and clicking the backdrop) is a genuine
cancel — no patch, no rewrite, just a log line saying so. Both modes share `openModal` and one
`renderTiles` (`setlist_match_action.js`); each opener's own `onDismiss` (§3) is what decides
which behaviour applies — `collectPicks(tilesEl)` for the pre-build soft gate, a plain `null`
for this one.

## 17. Guessing a missing key, and reviewing the guess

A song file with no `{key:}` directive at all gets one guessed for it, from chordprobook's own
`guessKey()` (its own SPEC.md §3.9) reading the same song's `chordsUsed` the build already
has parsed — no new parsing of its own, no UI required for a build to produce a usable
`musicalKey` at all. "Review keys…" (`reviewKeyGuesses`, `key_review_action.js` — labelled
"Change keys…" once every key has been confirmed), a check on the result card (§3) of the same
shape as §16's "Review setlist matches…", is where a human confirms, overrides, or corrects one
after the fact.

**Where the prior crate comes from.** `buildCrateFromChordProFolder` reads
`ro-crate-metadata.json` itself, direct from the folder, for this reuse (below). This is
separate from `readBookSettings` (§3), which reads the same file in the app for the title and
filename — title/filename persistence lives in the crate itself now, so there is no separate
prefill mechanism to keep in step.

**Guessing and reuse, in `buildSongEntity`.** For a song whose own `{key:}` is present
(`parsed.key`), nothing here applies at all — `musicalKey` is set from it directly, exactly as
before this feature existed, and no `custom:keyStatus` is written. Only for a song with none:

1. If a prior build's own crate already has a `musicalKey` for this exact song `@id`, carrying
   a `custom:keyStatus` of `"guessed"` or `"confirmed"` — read via a plain, best-effort read of
   `ro-crate-metadata.json` off `rootHandle` at the top of `buildCrateFromChordProFolder`
   (absent, or not valid JSON, is treated the same as "nothing to reuse", not an error) — that
   exact value and status are carried over unchanged. **The guesser does not run again.** This
   is what makes a human's own reviewed choice (below) stick across rebuilds, the same way an
   authored `{key:}` always has: once assigned, by a human or accepted as a guess, a key is
   settled until something explicitly changes it.
2. Otherwise, `guessKey(parsed.chordsUsed)` runs. If it returns anything, the first (best,
   possibly tied — chordprobook's own SPEC.md §3.9) candidate's `key` becomes `musicalKey`, and
   `custom:keyStatus` is set to `"guessed"`.
3. If `guessKey()` returns nothing at all (no chord had a recognised quality — chordprobook's
   own SPEC.md §3.9) — a lyrics-only file, say — `musicalKey` is left unset, same as an
   authored file that simply never had a key. No `custom:keyStatus` either: there is nothing
   guessed to flag.

`custom:keyStatus` is a new `rdf:Property` (§7's own table), added only when at least one
entity actually carries it (`addUsedPropertyDefinitions`, same discipline as
`custom:matchStatus`/`custom:matchCandidates`). Its three meaningful values:

| Value | Means |
|---|---|
| *(absent)* | The song's own `{key:}`, or no key at all — nothing this feature touched. |
| `"guessed"` | Assigned by `guessKey()`, not yet looked at by a human. |
| `"confirmed"` | A human opened the review modal and either accepted, changed, or hand-typed this value — never re-guessed again regardless of what the song's own chords do next. |

**The review modal.** "Review keys…" reads `ro-crate-metadata.json` fresh off disk
(same convention as §16's own review action), and lists every canonical `MusicComposition`
carrying a `custom:keyStatus` at all — `"guessed"` and `"confirmed"` alike, so a prior review
can always be revisited, exactly as §16's own post-build editor never limits itself to
still-unresolved entries either. For each: its title, the song's own chords (`chordsUsed`,
re-derived the same way as the candidates below — the actual evidence a guess rests on, not
just a bare key name to take on faith), a short row of candidate keys re-derived on the spot
(`new ChordProSong(entity.text)` then `.guessKey()` — the entity's own `text` is the song's
full, verbatim source, chordprobook's own SPEC.md §3.1, so this needs no second read of the
actual file) as clickable choices, and a plain text field — pre-filled with the current key,
directly editable — for typing any key at all, not only one `guessKey()` itself proposed.
Clicking a candidate fills the text field; nothing commits until "Save".

On "Save", every listed song's own `musicalKey` is set to whatever its text field currently
holds and its `custom:keyStatus` becomes `"confirmed"` — for every row shown, not only ones
actually changed, since appearing in this list and being saved *is* the act of a human looking
at it (unlike §16's own change-only patch, where an unreviewed default is still just as
provisional after Save as before it). A field cleared to empty removes `musicalKey`/
`custom:keyStatus` from that entity entirely, back to "no key assigned" — the one way to undo
a guess rather than replace it with another one. `writeOutputs` rewrites the crate and the
songbook directly from the patched JSON, same as §16, with no folder re-scan.

**Writing the key back into the file itself.** A checkbox in the same modal, off by default:
"Also add `{key:}` to the song files". When checked, every song actually saved with a
non-empty key — `"confirmed"` only; a file already has no `{key:}` of its own by definition,
so there is nothing to "add back" for one that was left `"guessed"` and not reviewed — gets a
`{key: <value>}` line inserted directly after its own `{title:}`/`{t:}` line (or at the very
top of the file, if it has neither), via a small, pure `insertKeyDirective(rawText, keyValue)`
(`chordpro_crate.js`) that touches nothing else in the file — no re-tidying, no line-ending
normalisation of anything outside the one inserted line, the same "operate on the original
text directly" discipline `st_directive.js`'s own `applyChoices` follows (§15). Every affected
file is backed up first, to a timestamped zip under `.chordpro-key-backups/` in the picked
folder — a sibling convention to, but a separate folder from, §15's own
`.chordpro-cleanup-backups/`, so the two tools' backups are never mixed together in one
listing. Once written, the file has its own real `{key:}`: the next build reads it as
authored, same as any other song that always had one — `custom:keyStatus` never appears for it
again, and neither this feature nor the reuse rule above has anything further to do with it.
Because files were rewritten, `reviewKeyGuesses` resolves to `{ changed, wroteSongFiles:
true }` and the app runs "Make songbook" again straight away (§3), so the crate's copy of each
song's text picks up the new line.

**Deferred (not built):** a pre-build soft gate analogous to §16's own (guessed keys are never
allowed to interrupt a build the way an unresolved setlist match can be made to); surfacing
chordprobook's own richer per-candidate breakdown (`chordsInKey`/`chordsOutOfKey`/
`ignoredChords`, its own SPEC.md §3.9) anywhere in the review modal itself, which currently
shows only each candidate's bare key; any confidence threshold below which a guess is withheld
rather than always assigning the top-scoring candidate regardless of how weak that score is.

## 18. Normalizing a key charted "as heard" instead of "as played"

This tool's own convention (`docs/chordpro-format.md`) is that `{key:}` is the *charted* key —
what the chord shapes actually written down spell — and `{capo:}` is independent of it: the
song's sounding key is the charted key transposed up by the capo. chordpro.org's own convention
disagrees: there, `{key:}` is the key the song sounds in, capo included. A song built the
chordpro.org way looks, from here, exactly like a chart in C shapes that someone mistyped as
"D" — the two are genuinely indistinguishable from the chords alone; only the presence of both
an authored `{key:}` *and* a `{capo:}` at all makes this worth checking. "Review capos and
keys…" (`normalizeCapoKeys`, `normalize_capo_key_action.js`) is a separate check on the result
card (§3), of the same shape as §16/§17's, deliberately separate from "Review keys…" rather
than a checkbox in that modal — the two features answer different questions (§17: "what key is this, if none was
given at all?" vs. this one: "does the key that *was* given actually mean what this tool expects
it to mean?") over an almost entirely disjoint set of songs (only ever those with both a
`{key:}` and a `{capo:}` already), and folding a whole second checkbox-per-song review flow onto
the far more common key review would make that one harder to read for no shared benefit.

**Detection, `detectCapoKeyMismatch(entity)` in `chordpro_crate.js`.** Only ever considers a
song entity that already has both a `custom:capo` and a `musicalKey` — no capo, nothing to
revert against; no key, nothing to compare (that's §17's own job instead). `guessKey()` runs
again over the song's own `chordsUsed` (the entity's `text`, re-parsed fresh, same convention as
§17's own candidate re-derivation), exactly as if this were a still-unguessed song. If the
authored key is already among the top-scoring candidates, the chart agrees with itself as
charted — nothing to flag. Otherwise, the authored key is transposed *down* by the capo amount
(chordprobook's own `Transposer.transposeKey`) to get the key the chart would have to be in if
the capo were the reason the guesser and the author disagree; only if *that* implied key is
itself among the guesser's top candidates is this flagged as a likely as-heard mistake, with
`{currentKey, suggestedKey, suggestedTranspose: "+<capo>", capo}` — `suggestedTranspose` is
always positive, since it exists only to recover the sounding key the capo's own upward shift
already reaches from the (lower) charted key. `extractCapoKeyMismatches(crateJson)` applies this
to every canonical `MusicComposition` in a crate already on disk, the same read-straight-off-disk
convention as `extractReviewableSongKeys`.

**The modal.** One tile per detected mismatch: the song's title, its own chords (same reasoning as
§17's own chord display — evidence to judge the suggestion against, not a bare claim to take on
faith), and a plain summary of the fix (`key: D, capo: 2` → `key: C, transpose: +2, capo: 2
(unchanged)`) next to a checkbox, **checked by default** — every detection this algorithm
surfaces is already a fairly specific coincidence (the chart's own top-scoring guess, the
authored key, and the capo amount all lining up at once), so a false positive here is expected
to be rare enough that defaulting to "apply it" costs less than making every user manually tick
songs that are, in the overwhelming majority of cases, exactly what they look like. Unticking a
song leaves it untouched entirely — no different from Cancel, for that one song alone. On
"Save", every still-ticked song's own `musicalKey`/`custom:transpose` are set directly in the
crate (the `{key:}`/`{capo:}` role split this whole feature exists to restore); `capo` itself is
never touched, since it was already correct — capped up 2 frets was always the physically true
thing, only the label on which key that produces was ever wrong.

**Writing the fix back into the file itself.** A checkbox in the same modal, off by default,
mirroring §17's own: "Also rewrite `{key:}` and `{transpose:}` in the song files (backs up
originals first)". Unlike §17 (where an unset `{key:}` always means inserting a brand-new
line), both directives here already exist in the file, so this always **replaces in place**
rather than inserting — `setDirectiveValue(rawText, directiveNames, value)`, a new
counterpart to `insertKeyDirective` sharing its own `insertDirectiveAfterTitle` helper, given a
list of acceptable spellings (`["transpose", "tr"]`, since either is valid chordpro and a given
file might use only one) so it finds and replaces whichever alias the file actually has, falling
back to inserting only if neither is present at all. `{key:}` is always present already (this
feature never fires without one), so its own replace path is always taken. Backups go to their
own timestamped zip under `.chordpro-normalize-backups/` — a third, separate backup folder
alongside §15's `.chordpro-cleanup-backups/` and §17's `.chordpro-key-backups/`, so no tool's
backups are ever mixed into another's listing.

**A crate-only fix does not survive a rebuild.** `buildSongEntity` (§17) always trusts an
authored `{key:}` over anything persisted from a prior crate — the whole reuse mechanism §17
relies on only ever activates for a song with *no* `{key:}` at all. A song fixed here in the
crate alone, with the write-back checkbox left unticked, still has its old, "wrong" `{key:}` on
disk; the very next rebuild reads that file fresh and reintroduces the exact same mismatch,
which the next run of this check will simply flag and offer to fix again. This is a known,
accepted limitation rather than a bug to engineer around: the file itself, not the crate, is
this tool's actual source of truth for an authored key (§5), and the write-back checkbox is the
one mechanism that changes what the file itself says — same as §17's own `{key:}` write-back
being what actually stops a guess from being re-derived. The app makes this matter more than it
used to: it rebuilds automatically after any tool that rewrites song files — a `{st:}` fix
(§15), or a key write-back (§17) — as well as on every "Make songbook", so a crate-only fix
made here is undone by the very next such rebuild, often within the same session; tick the
write-back checkbox unless the fix is only wanted until then.

**Deferred (not built):** any equivalent of §17's own `custom:keyStatus` tracking for this
feature — a fixed song looks, to a rebuild, identical to one that was always charted correctly,
which is only a problem in combination with the crate-only-fix limitation just above; a
pre-build soft gate analogous to §16's own.
