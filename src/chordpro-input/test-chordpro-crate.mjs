// Integration test for buildCrateFromChordProFolder
// (src/chordpro-input/chordpro_crate.js), exercised against the real
// chordprosite sample files under this repo's own samples/ rather than
// synthetic fixtures — see SPEC.md for the design this implements.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChordProSong, guessKey } from "chordprobook";
import {
  buildCrateFromChordProFolder, rankCandidatesByPath, findAmbiguousSetlistMatches, extractPersistedSetlistMatches,
  extractReviewableSetlistMatches, extractReviewableSongKeys, insertKeyDirective,
  extractCapoKeyMismatches, setDirectiveValue,
} from "./chordpro_crate.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");

/* ---------- an in-memory stand-in for FileSystemDirectoryHandle ---------- */
// Only what chordpro_crate.js's folder walk actually calls: values() for
// directory listing and getFile() on a file handle — no writing, since the
// folder walk never writes (test-songbook-build.mjs has a read/write one).
function toNode(value) {
  if (value instanceof Uint8Array) return { kind: "file", bytes: value };
  const children = new Map();
  for (const [childName, childValue] of Object.entries(value)) children.set(childName, toNode(childValue));
  return { kind: "dir", children };
}

function wrapNode(name, node) {
  if (node.kind === "file") {
    return { kind: "file", name, async getFile() { return new File([node.bytes], name); } };
  }
  return {
    kind: "directory",
    name,
    async *values() {
      for (const [childName, child] of node.children) yield wrapNode(childName, child);
    },
  };
}

function memoryDirHandle(name, tree) {
  return wrapNode(name, toNode(tree));
}

/* ---------- fixture: the real chordprosite sample files, read from disk ---------- */

const SONG_FILENAMES = [
  "AmazingGrace.cho.txt", "gimme_a_u.cho.txt", "i_called_your_name.cho.txt",
  "slot_machine_baby.cho.txt", "ukulele_train.cho.txt", "uni-verse.cho.txt",
];
const SETLIST_FILENAME = "sample.setlist.md";

const tree = {};
for (const name of [...SONG_FILENAMES, SETLIST_FILENAME]) {
  tree[name] = readFileSync(path.join(fixturesDir, name));
}
// A file that shouldn't be picked up at all — neither a recognised song
// extension nor the setlist suffix.
tree["README.md"] = Buffer.from("not a setlist");
// A file nested in a subfolder — subfolders carry no structural meaning in
// this input mode (SPEC.md §4/§9), so this should be found and treated as
// an ordinary song, same as one sitting at the top level.
tree["extra"] = { "another_song.pro": Buffer.from("{title: Another Song}\n{key: A}\n[A]La la") };

const dirHandle = memoryDirHandle("root", tree);

/* ---------- run the build ---------- */

const messages = [];
const result = await buildCrateFromChordProFolder(dirHandle, {}, (msg) => messages.push(msg));

assert.ok(result, "expected a result — the fixture folder is not empty");
assert.equal(result.songCount, SONG_FILENAMES.length + 1); // +1 for extra/another_song.pro
assert.equal(result.setlistCount, 1);
assert.equal(result.unresolvedCount, 0);
assert.equal(result.ambiguousCount, 0);

// .toJSON() (crate.graph is the live, linked proxy — its array:true option
// means every property reads back as an array; .toJSON() is the plain JSON-LD
// shape actually written to ro-crate-metadata.json).
const graph = result.crate.toJSON()["@graph"];
const byId = new Map(graph.map((entity) => [entity["@id"], entity]));
const byType = (type) => graph.filter((entity) => {
  const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
  return types.includes(type);
});

/* ---------- root dataset ---------- */

const rootDataset = byId.get(result.crate.rootDataset["@id"]);
assert.equal(rootDataset.name, "Songbook");
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rootDataset.datePublished));
assert.equal(rootDataset.hasPart.length, SONG_FILENAMES.length + 1 + 1); // songs + setlist

/* ---------- README.md was ignored, the nested song was not ---------- */

assert.equal(byId.has("README.md"), false);
const nestedSong = byId.get("extra/another_song.pro");
assert.ok(nestedSong, "a song nested in a subfolder should still be found and built");
assert.equal(nestedSong.name, "Another Song");

/* ---------- Song entities ---------- */
// Both a canonical Song and a setlist-entry proxy are typed MusicComposition
// (SPEC.md §7) — the two are told apart here by specializationOf/
// custom:matchStatus (songbook_html.js's own isCanonicalSong, same check),
// not by @id shape or by whether "text" is present: an entry can carry its
// own `text` too now (its performance note, SPEC.md §6/§7), so that check
// would wrongly count an entry-with-a-note as a canonical song.
// specializationOf alone isn't quite enough either — an unresolved entry
// has none, since there's genuinely nothing for it to specialize — so
// custom:matchStatus (written unconditionally onto every entry, resolved or
// not, and never onto a canonical Song) covers that gap.
const isSetlistEntryProxy = (entity) => "specializationOf" in entity || "custom:matchStatus" in entity;
const musicCompositions = byType("MusicComposition");
const canonicalSongs = musicCompositions.filter((entity) => !isSetlistEntryProxy(entity));
assert.equal(canonicalSongs.length, SONG_FILENAMES.length + 1);

const amazingGrace = byId.get("AmazingGrace.cho.txt");
assert.equal(amazingGrace.name, "Amazing Grace");
assert.equal(amazingGrace.musicalKey, "G");
assert.equal(amazingGrace.text, readFileSync(path.join(fixturesDir, "AmazingGrace.cho.txt"), "utf8"));
assert.equal("composer" in amazingGrace, false); // no {composer} directive in this file
assert.equal("performer" in amazingGrace, false); // no {artist} directive in this file
assert.equal("subtitle" in amazingGrace, false); // no {subtitle}/{st} directive in this file
assert.equal("custom:capo" in amazingGrace, false); // no {capo} directive anywhere in the fixture set

// {st: Peter Sefton} — a *subtitle* directive, not {artist}, so it lands on
// `subtitle`, not `performer` (SPEC.md §5/§7 — the two used to be one
// conflated field, custom:artist).
const iCalledYourName = byId.get("i_called_your_name.cho.txt");
assert.equal(iCalledYourName.subtitle, "Peter Sefton");
assert.equal("performer" in iCalledYourName, false);
assert.equal(iCalledYourName["custom:transpose"], "+7");

/* ---------- Setlist + set + setlist-entry entities (SPEC.md §6) ---------- */

const setlist = byId.get(SETLIST_FILENAME);
assert.ok(setlist);
assert.equal(setlist["@type"], "MusicPlaylist");
assert.equal(setlist.name, "Gig number 1,000");
// Both "#" sets from the sample file (Set 1, Set 2) became their own nested
// MusicPlaylist entities — the top-level setlist's own hasPart points at
// those two, not at the four entries directly (SPEC.md §6).
assert.equal(setlist.hasPart.length, 2);

const set1 = byId.get(setlist.hasPart[0]["@id"]);
const set2 = byId.get(setlist.hasPart[1]["@id"]);
assert.equal(set1["@id"], `${SETLIST_FILENAME}#set-1`);
assert.equal(set1["@type"], "MusicPlaylist");
assert.equal(set1.name, "Set 1");
assert.equal(set2["@id"], `${SETLIST_FILENAME}#set-2`);
assert.equal(set2["@type"], "MusicPlaylist");
assert.equal(set2.name, "Set 2");
// Both sets have their own freeform text between the "#" heading and their
// first entry in this fixture (added specifically to exercise this — SPEC.md
// §6/§6.2) — stored as `text`, like an entry's own note, not `description`
// (a deliberate overload of the property name the canonical Song entity
// uses for something different — its own verbatim ChordPro source).
assert.equal(set1.text, "This is our last gig so make it a good one\n1. No spitting!\n2. Not too much fighting");
assert.equal(set2.text, "Maybe we shouldn't quit?");

assert.equal(set1.hasPart.length, 3); // Slot Machine Baby, Uni, Amazing
assert.equal(set2.hasPart.length, 1); // Baby

const entryIds = [...set1.hasPart, ...set2.hasPart].map((ref) => ref["@id"]);
assert.deepEqual(entryIds, [
  `${SETLIST_FILENAME}#entry-1`, `${SETLIST_FILENAME}#entry-2`,
  `${SETLIST_FILENAME}#entry-3`, `${SETLIST_FILENAME}#entry-4`,
]);

const entries = entryIds.map((id) => byId.get(id));
const [slotMachineEntry, uniEntry, amazingEntry, babyEntry] = entries;

// None of the four entries carry the *song's* own text — only, when they
// have a performance note of their own, their own `text` (SPEC.md §6/§7,
// a deliberate overload of the same property name the canonical Song uses
// for something different: verbatim ChordPro source vs. a Markdown note).
// Which set (if any) an entry belongs to is expressed by which set's own
// hasPart references it (above), not by a property on the entry itself —
// there is no custom:setName any more (SPEC.md §7).
for (const entry of entries) {
  assert.equal(entry["@type"], "MusicComposition");
  assert.equal("custom:setName" in entry, false);
}

assert.equal(slotMachineEntry.name, "Slot Machine Baby");
assert.equal(slotMachineEntry["custom:matchStatus"], "exact");
assert.deepEqual(slotMachineEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(slotMachineEntry.text, "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!");

assert.equal(uniEntry.name, "Uni");
assert.equal(uniEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(uniEntry.specializationOf, { "@id": "uni-verse.cho.txt" });
assert.equal("text" in uniEntry, false);

assert.equal(amazingEntry.name, "Amazing");
assert.equal(amazingEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(amazingEntry.specializationOf, { "@id": "AmazingGrace.cho.txt" });
assert.equal(amazingEntry.text, "Make it amazing!");

assert.equal(babyEntry.name, "Baby");
assert.equal(babyEntry["custom:transpose"], "-2");
assert.equal(babyEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(babyEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(babyEntry.text, "Play slow this time.");

// No entry in this fixture set is ambiguous or unresolved, so none of them
// should carry a matchCandidates property at all.
for (const entry of entries) assert.equal("custom:matchCandidates" in entry, false);

/* ---------- rdf:Property definitions: only for the irreducible custom fields ---------- */

const propertyDefIds = byType("rdf:Property").map((entity) => entity["@id"]);
for (const expected of [
  "arcp://name,custom/terms#transpose", "arcp://name,custom/terms#matchStatus",
]) {
  assert.ok(propertyDefIds.includes(expected), `expected an rdf:Property definition for ${expected}`);
}
// musicalKey/hasPart/specializationOf/description/performer/subtitle are all
// standard schema.org properties (SPEC.md §7) — they must NOT get a custom
// rdf:Property definition even though performer/subtitle are used in this
// very fixture set (iCalledYourName's own {st}, above). custom:artist is
// gone entirely now (the property {artist}/{subtitle} used to share, before
// the split) — no fixture, past or future, should ever mint it again.
// custom:setName is gone too, superseded by the set/sub-playlist hierarchy
// itself (SPEC.md §6/§7) — hasPart already covers what it used to. {capo}/
// {composer} and an ambiguous match simply don't occur anywhere in this
// fixture set, so those stay absent for the more familiar "never used"
// reason.
for (const unexpected of [
  "arcp://name,custom/terms#musicalKey", "arcp://name,custom/terms#hasPart",
  "arcp://name,custom/terms#specializationOf", "arcp://name,custom/terms#description",
  "arcp://name,custom/terms#performer", "arcp://name,custom/terms#subtitle",
  "arcp://name,custom/terms#artist", "arcp://name,custom/terms#setName",
  "arcp://name,custom/terms#capo", "arcp://name,custom/terms#composer", "arcp://name,custom/terms#matchCandidates",
]) {
  assert.equal(propertyDefIds.includes(unexpected), false, `did not expect an rdf:Property definition for ${unexpected}`);
}

/* ---------- progress messages reached ctx.log via onProgress ---------- */

assert.ok(messages.some((m) => m.includes("Found 7 song file(s) and 1 setlist file(s).")));
assert.equal(messages.some((m) => m.includes("Warning")), false);

/* ---------- an empty folder produces no crate at all ---------- */

{
  const emptyResult = await buildCrateFromChordProFolder(memoryDirHandle("empty", {}), {}, () => {});
  assert.equal(emptyResult, null);
}

/* ---------- {capo}/{artist}: not exercised by the main fixture set above ---------- */

{
  // A string, not the number ChordProSong itself parses {capo} into
  // (buildSongEntity, SPEC.md §5) — every other extracted directive on a
  // Song entity is already a plain string (musicalKey/composer/transpose
  // can all hold non-numeric text), and capo's own crate representation
  // follows that convention now too. {artist} — distinct from {subtitle}/
  // {st}, which the main fixture set above already covers via
  // i_called_your_name.cho.txt — becomes `performer`.
  const tree = {
    "capo_and_artist.cho.txt": Buffer.from(
      "{title: Capo Test}\n{artist: The Testers}\n{capo: 2}\n{key: D}\n[D]Some lyrics",
    ),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const song = graph.find((entity) => entity["@id"] === "capo_and_artist.cho.txt");
  assert.equal(song["custom:capo"], "2");
  assert.equal(typeof song["custom:capo"], "string");
  assert.equal(song.performer, "The Testers");
  assert.equal("subtitle" in song, false);

  const propertyIds = graph
    .filter((entity) => (Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]]).includes("rdf:Property"))
    .map((entity) => entity["@id"]);
  assert.ok(propertyIds.includes("arcp://name,custom/terms#capo"));
  assert.equal(propertyIds.includes("arcp://name,custom/terms#artist"), false); // no such property any more
}

/* ---------- setlist set hierarchy (SPEC.md §6): edge cases beyond the main fixture ---------- */

{
  // A setlist that never uses "#" at all — flat, exactly as every setlist
  // behaved before "#" sets existed as their own entities. No set entities
  // at all, and the top-level setlist's own hasPart points directly at the
  // two entries.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "flat.setlist.md": Buffer.from("## Song A\n## Song B"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("flat.setlist.md");
  assert.equal(setlist.hasPart.length, 2);
  assert.deepEqual(setlist.hasPart.map((r) => r["@id"]), ["flat.setlist.md#entry-1", "flat.setlist.md#entry-2"]);
  const setEntities = graph.filter((e) => String(e["@id"]).includes("#set-"));
  assert.equal(setEntities.length, 0);
}

{
  // A "#" set with freeform text between its own heading and its first
  // entry (chordprobook's own Setlist.js SPEC.md §3.2) becomes that set
  // entity's own `text` — it can be Markdown and songbook_html.js renders
  // it as such (SPEC.md §6.2), so `description` (conventionally a short
  // plain-text summary) isn't the right property for it; no custom
  // rdf:Property is needed either way, since `text` is already standard.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "notes.setlist.md": Buffer.from("# Set 1\nTune guitars to drop D now.\n## Song A"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const set1 = byId.get("notes.setlist.md#set-1");
  assert.ok(set1, "expected a set-1 entity");
  assert.equal(set1.name, "Set 1");
  assert.equal(set1.text, "Tune guitars to drop D now.");
  assert.equal(set1.hasPart.length, 1);
  assert.equal(set1.hasPart[0]["@id"], "notes.setlist.md#entry-1");
}

{
  // Entries before the first "#" heading stay direct children of the
  // top-level setlist, interleaved in file order with whichever "#" sets
  // follow — not folded into the first set, and not requiring one to exist
  // at all.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "song-c.cho.txt": Buffer.from("{title: Song C}\n[E]La"),
    "mixed.setlist.md": Buffer.from("## Song A\n# Set 1\n## Song B\n## Song C"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("mixed.setlist.md");
  // [entry-1 (Song A, ungrouped), set-1 (Song B, Song C)]
  assert.equal(setlist.hasPart.length, 2);
  assert.equal(setlist.hasPart[0]["@id"], "mixed.setlist.md#entry-1");
  assert.equal(setlist.hasPart[1]["@id"], "mixed.setlist.md#set-1");
  const entryA = byId.get("mixed.setlist.md#entry-1");
  assert.equal(entryA.name, "Song A");
  const set1 = byId.get("mixed.setlist.md#set-1");
  assert.equal(set1.hasPart.length, 2);
  assert.deepEqual(set1.hasPart.map((r) => r["@id"]), ["mixed.setlist.md#entry-2", "mixed.setlist.md#entry-3"]);
}

{
  // Two "#" sets that happen to share a literal name — SPEC.md §6 documents
  // this as a known, accepted simplification: they're only kept apart when
  // something (another set, or the end of the file) actually separates
  // them, since grouping is purely by contiguous runs of matching setName,
  // not by tracking each "#" line's own position. Adjacent-but-distinct
  // "# Encore" blocks would collapse into one set entity here — this test
  // documents that behaviour rather than treating it as a bug.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "song-c.cho.txt": Buffer.from("{title: Song C}\n[E]La"),
    "repeated.setlist.md": Buffer.from("# Set 1\n## Song A\n# Set 2\n## Song B\n# Set 1\n## Song C"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("repeated.setlist.md");
  // Three groups, not two: "Set 1" (Song A) and the later, separate "Set 1"
  // (Song C) are non-adjacent (Set 2 sits between them), so they stay
  // distinct set entities despite sharing a name.
  assert.equal(setlist.hasPart.length, 3);
  const [firstSet1, set2, secondSet1] = setlist.hasPart.map((r) => byId.get(r["@id"]));
  assert.equal(firstSet1.name, "Set 1");
  assert.equal(firstSet1.hasPart.length, 1);
  assert.equal(set2.name, "Set 2");
  assert.equal(secondSet1.name, "Set 1");
  assert.equal(secondSet1.hasPart.length, 1);
  assert.notEqual(firstSet1["@id"], secondSet1["@id"]); // two distinct entities, same name
}

/* ---------- resolving ambiguous matches (SPEC.md §16) ---------- */

{
  // rankCandidatesByPath: pure, no folder handle involved. Depth is counted
  // in directory segments only — the setlist's own filename never counts,
  // and neither does a candidate's.
  const candidates = [
    { id: "originals/Sunrise.cho.txt", title: "Sunrise" },
    { id: "gigs/friday/Sunrise.cho.txt", title: "Sunrise" },
    { id: "gigs/Sunrise.cho.txt", title: "Sunrise" },
  ];
  const ranked = rankCandidatesByPath("gigs/friday/gig.setlist.md", candidates);
  assert.deepEqual(ranked.map((c) => c.id), [
    "gigs/friday/Sunrise.cho.txt", // shares "gigs", "friday" — depth 2
    "gigs/Sunrise.cho.txt",        // shares "gigs" only — depth 1
    "originals/Sunrise.cho.txt",   // shares nothing — depth 0
  ]);
}

{
  // A tie in shared-segment count keeps the candidates' own original order
  // (matchEntryToSong's own scan order, itself alphabetical by path — see
  // harvestFilesAndTitles) rather than inventing a second tiebreak.
  const candidates = [
    { id: "venues/north/Anthem.cho.txt", title: "Anthem" },
    { id: "venues/south/Anthem.cho.txt", title: "Anthem" },
  ];
  const ranked = rankCandidatesByPath("setlists/solstice.setlist.md", candidates);
  assert.deepEqual(ranked.map((c) => c.id), ["venues/north/Anthem.cho.txt", "venues/south/Anthem.cho.txt"]);
  // Order in the array passed in is what's kept — reversing the input
  // reverses which one "wins" the tie, proving this isn't coincidentally
  // alphabetical.
  const rankedReversed = rankCandidatesByPath("setlists/solstice.setlist.md", [...candidates].reverse());
  assert.deepEqual(rankedReversed.map((c) => c.id), ["venues/south/Anthem.cho.txt", "venues/north/Anthem.cho.txt"]);
}

// A small dummy tree reused by every test below: two songs sharing the
// title "Sunrise" — one off on its own, one right next to the setlist that
// references it — so path-proximity has an actual, checkable answer
// ("closest in the tree", PT's own phrasing), not just "first in scan
// order" (which "originals/..." sorting before "gigs/..." would otherwise
// make indistinguishable from the real fix).
function ambiguousTree() {
  return {
    originals: {
      "Sunrise.cho.txt": Buffer.from("{title: Sunrise}\n[C]Far from the gig"),
    },
    gigs: {
      friday: {
        "Sunrise.cho.txt": Buffer.from("{title: Sunrise}\n[D]Right next door"),
        "gig.setlist.md": Buffer.from("## Sunrise"),
      },
    },
  };
}

{
  // findAmbiguousSetlistMatches: the lightweight pre-scan, no crate built.
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", ambiguousTree()));
  assert.equal(found.entries.length, 1);
  const [entry] = found.entries;
  assert.equal(entry.setlistPath, "gigs/friday/gig.setlist.md");
  assert.equal(entry.rawHeading, "Sunrise");
  assert.equal(entry.setName, "");
  assert.deepEqual(entry.candidates.map((c) => c.id), ["gigs/friday/Sunrise.cho.txt", "originals/Sunrise.cho.txt"]);
  assert.equal(typeof entry.key, "string");
  // Every harvested song, not just this entry's own candidates — main.js
  // uses this to tell "the file is genuinely gone" apart from "it exists
  // but no longer matches" when validating a persisted choice.
  assert.deepEqual(found.songs.map((s) => s.id).sort(), ["gigs/friday/Sunrise.cho.txt", "originals/Sunrise.cho.txt"]);
}

{
  // An exact, fuzzy, or unresolved entry is never reported as ambiguous —
  // this pre-scan is scoped to exactly what SPEC.md §16 is about.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "clean.setlist.md": Buffer.from("## Song A\n## Nothing Like This"),
  };
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  assert.equal(found.entries.length, 0);
}

{
  // buildCrateFromChordProFolder, no override supplied at all: the
  // ambiguous entry resolves to the path-proximity default, and
  // custom:matchCandidates lists both candidates closest-first — the
  // crate's own data and the review UI's default can never disagree
  // about which one is "closest" (SPEC.md §16).
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", ambiguousTree()), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const entry = byId.get("gigs/friday/gig.setlist.md#entry-1");
  assert.equal(entry["custom:matchStatus"], "ambiguous");
  assert.deepEqual(entry.specializationOf, { "@id": "gigs/friday/Sunrise.cho.txt" });
  assert.deepEqual(entry["custom:matchCandidates"].map((c) => c["@id"]), [
    "gigs/friday/Sunrise.cho.txt", "originals/Sunrise.cho.txt",
  ]);
  assert.equal(result.ambiguousCount, 1);
}

{
  // opts.matchOverrides: a human's own pick (via findAmbiguousSetlistMatches's
  // own key, exactly as main.js's review modal would produce it) beats the
  // path-proximity default.
  const tree = ambiguousTree();
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [entry] = found.entries;
  const nonDefaultChoice = "originals/Sunrise.cho.txt"; // not the path-proximity default
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: { [entry.key]: nonDefaultChoice },
  });
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const entryEntity = byId.get("gigs/friday/gig.setlist.md#entry-1");
  assert.deepEqual(entryEntity.specializationOf, { "@id": nonDefaultChoice });
  // The override decides which candidate specializationOf points to; it
  // doesn't reshuffle the candidate list itself, which stays closest-first
  // regardless of which one a human went on to pick.
  assert.deepEqual(entryEntity["custom:matchCandidates"].map((c) => c["@id"]), [
    "gigs/friday/Sunrise.cho.txt", "originals/Sunrise.cho.txt",
  ]);
}

{
  // extractPersistedSetlistMatches: reads a real, previously-built crate's
  // own JSON (not a hand-rolled shape) for every ambiguous entry a human
  // has already resolved, keyed the same way findAmbiguousSetlistMatches's
  // own results are.
  const tree = ambiguousTree();
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [entry] = found.entries;
  const chosen = "originals/Sunrise.cho.txt";
  const priorResult = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: { [entry.key]: chosen },
  });
  const priorCrateJson = priorResult.crate.toJSON();

  const persisted = extractPersistedSetlistMatches(priorCrateJson);
  assert.deepEqual(persisted, { [entry.key]: chosen });
}

/* ---------- reviewing already-built matches, post-build (SPEC.md §16) ---------- */

{
  // extractReviewableSetlistMatches: reads every entry that was *ever*
  // ambiguous (has custom:matchCandidates at all), not just ones still
  // needing a decision — the "I noticed a mistake after building" review,
  // distinct from findAmbiguousSetlistMatches's own pre-build scan. Fresh
  // build, no override: current and recommended agree, since nothing's
  // overridden anything yet.
  const tree = ambiguousTree();
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const crateJson = result.crate.toJSON();

  const reviewable = extractReviewableSetlistMatches(crateJson);
  assert.equal(reviewable.length, 1);
  const [entry] = reviewable;
  assert.equal(entry.setlistPath, "gigs/friday/gig.setlist.md");
  assert.equal(entry.setName, "");
  assert.equal(entry.rawHeading, "Sunrise");
  assert.equal(entry.currentId, "gigs/friday/Sunrise.cho.txt");
  assert.equal(entry.recommendedId, "gigs/friday/Sunrise.cho.txt");
  assert.equal(entry.currentId, entry.recommendedId);
  assert.deepEqual(entry.candidates.map((c) => c.id), ["gigs/friday/Sunrise.cho.txt", "originals/Sunrise.cho.txt"]);
  assert.deepEqual(entry.candidates.map((c) => c.title), ["Sunrise", "Sunrise"]); // each song's own name, not its id
  assert.equal(typeof entry.key, "string");
}

{
  // A human overrode the path-proximity default — currentId reflects that
  // override; recommendedId still reflects what rankCandidatesByPath would
  // pick on its own, independent of what was actually chosen, so a
  // reviewer can see the two have drifted apart and reconsider.
  const tree = ambiguousTree();
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [ambiguous] = found.entries;
  const overridden = "originals/Sunrise.cho.txt"; // not the path-proximity default
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: { [ambiguous.key]: overridden },
  });
  const crateJson = result.crate.toJSON();

  const [entry] = extractReviewableSetlistMatches(crateJson);
  assert.equal(entry.currentId, overridden);
  assert.equal(entry.recommendedId, "gigs/friday/Sunrise.cho.txt"); // unchanged — still the closest one
  assert.notEqual(entry.currentId, entry.recommendedId);
}

{
  // setName context comes from walking the crate's own set/setlist hasPart
  // structurally (SPEC.md §6/§7) — there's no property on the entry itself
  // to read it from, unlike findAmbiguousSetlistMatches's pre-build scan,
  // which gets it for free from Setlist.js's own parsed entry.setName.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Sunrise}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Sunrise}\n[D]La"),
    "gig.setlist.md": Buffer.from("# Set 1\n## Sunrise"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const crateJson = result.crate.toJSON();

  const [entry] = extractReviewableSetlistMatches(crateJson);
  assert.equal(entry.setlistPath, "gig.setlist.md");
  assert.equal(entry.setName, "Set 1");
}

{
  // Full round trip: a human's own choice, once made, survives a later
  // rebuild of the same folder without being re-asked — SPEC.md §16's own
  // "persisting choices" behaviour, exercised end to end rather than just
  // at the extraction step above. The chosen candidate here is
  // deliberately the *non*-default one, so this can only pass if the prior
  // choice actually won over path-proximity, not by coincidence.
  const tree = ambiguousTree();
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [entry] = found.entries;
  const chosen = "originals/Sunrise.cho.txt";

  const firstBuild = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: { [entry.key]: chosen },
  });
  const persisted = extractPersistedSetlistMatches(firstBuild.crate.toJSON());

  // Simulates main.js: a fresh scan finds the same ambiguity again, a prior
  // crate is read, and its persisted choice — still among this entry's own
  // current candidates — is reused as this rebuild's own override, with no
  // human asked to pick anything a second time.
  const rebuildFound = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [rebuildEntry] = rebuildFound.entries;
  const stillValid = rebuildEntry.candidates.some((c) => c.id === persisted[rebuildEntry.key]);
  assert.ok(stillValid);

  const secondBuild = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: persisted,
  });
  const graph = secondBuild.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  assert.deepEqual(byId.get("gigs/friday/gig.setlist.md#entry-1").specializationOf, { "@id": chosen });
}

// A three-way ambiguous tree, for the "the previously-chosen file is now
// gone, but the entry is still ambiguous" test below — ambiguousTree()'s
// own two candidates can't exercise that: delete either one of only two
// and the entry stops being ambiguous at all (down to a clean single
// match), which is a different, equally fine outcome (below) but not this
// one.
function threeWayAmbiguousTree() {
  return {
    originals: { "Sunrise.cho.txt": Buffer.from("{title: Sunrise}\n[C]Far from the gig") },
    covers: { "Sunrise.cho.txt": Buffer.from("{title: Sunrise}\n[E]Another take") },
    gigs: {
      friday: {
        "Sunrise.cho.txt": Buffer.from("{title: Sunrise}\n[D]Right next door"),
        "gig.setlist.md": Buffer.from("## Sunrise"),
      },
    },
  };
}

{
  // The previously-chosen file is now gone from the folder entirely
  // (deleted since the last build), but the entry is still ambiguous
  // between its two remaining candidates — the persisted choice must not
  // be silently trusted just because it's on record. main.js's own guard
  // (checking the id against every currently-harvested song, not just this
  // one entry's own candidates) is what actually catches this, so this
  // test exercises that check directly rather than assuming
  // chordpro_crate.js itself would refuse a stale override (it doesn't —
  // buildCrateFromChordProFolder trusts whatever override map it's
  // handed, same as it always has; validating it first is the caller's
  // job, SPEC.md §16).
  const tree = threeWayAmbiguousTree();
  const found = await findAmbiguousSetlistMatches(memoryDirHandle("root", tree));
  const [entry] = found.entries;
  const chosen = "originals/Sunrise.cho.txt"; // deliberately not the path-proximity default
  const firstBuild = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {}, {
    matchOverrides: { [entry.key]: chosen },
  });
  const persisted = extractPersistedSetlistMatches(firstBuild.crate.toJSON());
  assert.deepEqual(persisted, { [entry.key]: chosen });

  const prunedTree = threeWayAmbiguousTree();
  delete prunedTree.originals; // the previously-chosen song's own file is gone

  const rebuildFound = await findAmbiguousSetlistMatches(memoryDirHandle("root", prunedTree));
  assert.equal(rebuildFound.entries.length, 1); // still ambiguous — two candidates remain
  const songIds = new Set(rebuildFound.songs.map((s) => s.id));
  const [rebuildEntry] = rebuildFound.entries;
  const persistedId = persisted[rebuildEntry.key];
  assert.equal(songIds.has(persistedId), false); // confirms the file really is gone, not just unmatched
  assert.equal(rebuildEntry.candidates.some((c) => c.id === persistedId), false);
  assert.deepEqual(rebuildEntry.candidates.map((c) => c.id), ["gigs/friday/Sunrise.cho.txt", "covers/Sunrise.cho.txt"]);
}

{
  // The two-candidate case: deleting the previously-chosen file leaves only
  // one candidate standing, so the entry isn't ambiguous on the next scan
  // at all — findAmbiguousSetlistMatches simply stops reporting it, and a
  // fresh build resolves it as a clean "exact" match to whichever song is
  // actually still there. No stale reference anywhere to guard against,
  // since there's nothing left to be ambiguous between.
  const prunedTree = ambiguousTree();
  delete prunedTree.originals;
  const rebuildFound = await findAmbiguousSetlistMatches(memoryDirHandle("root", prunedTree));
  assert.equal(rebuildFound.entries.length, 0);

  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", prunedTree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const entryEntity = byId.get("gigs/friday/gig.setlist.md#entry-1");
  assert.equal(entryEntity["custom:matchStatus"], "exact");
  assert.deepEqual(entryEntity.specializationOf, { "@id": "gigs/friday/Sunrise.cho.txt" });
}

/* ---------- guessing a missing key (SPEC.md §17) ---------- */

{
  // No {key:} at all — the entity gets a guessed one, plus custom:keyStatus
  // "guessed". Computed independently here via chordprobook's own
  // ChordProSong/guessKey (not hand-derived music theory), same "match the
  // real implementation's real output" convention chordprobook's own
  // SPEC.md §6 documents.
  const text = "{title: No Key Here}\n[G]This [C]song has [D]no key [Em]directive";
  const expected = guessKey(new ChordProSong(text).chordsUsed);
  assert.ok(expected.length, "expected this chord set to yield at least one guess");

  const tree = { "song.cho.txt": Buffer.from(text) };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const entity = result.crate.toJSON()["@graph"].find((e) => e["@id"] === "song.cho.txt");
  assert.equal(entity.musicalKey, expected[0].key);
  assert.equal(entity["custom:keyStatus"], "guessed");
}

{
  // An authored {key:} is untouched — no custom:keyStatus at all, guesser
  // never even runs (a bare chord list that would obviously guess
  // differently, {key: F}, is used deliberately, so this could only pass if
  // the authored value actually won).
  const tree = { "song.cho.txt": Buffer.from("{title: Has A Key}\n{key: F}\n[G]Everything [C]else [D]says otherwise") };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const entity = result.crate.toJSON()["@graph"].find((e) => e["@id"] === "song.cho.txt");
  assert.equal(entity.musicalKey, "F");
  assert.equal("custom:keyStatus" in entity, false);
}

{
  // No chords at all: guessKey() has nothing to work with (chordprobook's
  // own SPEC.md §3.9) — musicalKey stays unset entirely, same as an
  // authored file that simply never had a key, not a guess of "no key".
  const tree = { "song.cho.txt": Buffer.from("{title: Lyrics Only}\nJust words, no brackets anywhere.") };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const entity = result.crate.toJSON()["@graph"].find((e) => e["@id"] === "song.cho.txt");
  assert.equal("musicalKey" in entity, false);
  assert.equal("custom:keyStatus" in entity, false);
}

{
  // Rebuild reuse: a "confirmed" key from a prior crate — deliberately one
  // this song's own chords would never guess on their own, so this can only
  // pass if the prior value actually won over a fresh guess, not by
  // coincidence. Simulates a human having reviewed and hand-typed a key via
  // "Review guessed keys…" (SPEC.md §17), then rebuilding without changing
  // the song file itself.
  const text = "{title: Reused Key}\n[G]This [C]song [D]would guess [Em]something else";
  const tree = { "song.cho.txt": Buffer.from(text) };

  const firstBuild = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const priorCrateJson = firstBuild.crate.toJSON();
  const priorEntity = priorCrateJson["@graph"].find((e) => e["@id"] === "song.cho.txt");
  priorEntity.musicalKey = "Bb"; // a human's own override — not what the chords above would guess
  priorEntity["custom:keyStatus"] = "confirmed";

  const rebuildTree = { ...tree, "ro-crate-metadata.json": Buffer.from(JSON.stringify(priorCrateJson)) };
  const secondBuild = await buildCrateFromChordProFolder(memoryDirHandle("root", rebuildTree), {}, () => {});
  const rebuiltEntity = secondBuild.crate.toJSON()["@graph"].find((e) => e["@id"] === "song.cho.txt");
  assert.equal(rebuiltEntity.musicalKey, "Bb");
  assert.equal(rebuiltEntity["custom:keyStatus"], "confirmed");
}

{
  // extractReviewableSongKeys: both "guessed" and "confirmed" entries are
  // reviewable (a prior review is always revisitable, SPEC.md §17); a
  // setlist-entry proxy and an authored-key song are both excluded, even
  // though the former is also typed MusicComposition.
  const text = "{title: Reviewable}\n[C]One [F]two [G]three";
  const tree = {
    "song.cho.txt": Buffer.from(text),
    "authored.cho.txt": Buffer.from("{title: Authored}\n{key: A}\n[A]Has its own key"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const crateJson = result.crate.toJSON();
  const reviewable = extractReviewableSongKeys(crateJson);

  assert.equal(reviewable.length, 1);
  const [item] = reviewable;
  assert.equal(item.id, "song.cho.txt");
  assert.equal(item.title, "Reviewable");
  assert.equal(item.keyStatus, "guessed");
  assert.equal(item.currentKey, guessKey(new ChordProSong(text).chordsUsed)[0].key);
  assert.ok(Array.isArray(item.candidates) && item.candidates.length);
  assert.deepEqual(item.chordsUsed, ["C", "F", "G"]);
}

/* ---------- extractCapoKeyMismatches / detectCapoKeyMismatch (SPEC.md §18) ---------- */

{
  // The motivating case: a chart written in C shapes, capped up 2, but
  // typed up as {key: D} the chordpro.org way (key = what it sounds like) —
  // this tool's own convention (docs/chordpro-format.md) instead expects
  // {key:} to be the charted key, independent of {capo:}. C major and its
  // relative A minor tie for best coverage over C/F/G/Am (chordprobook's
  // own SPEC.md §3.9 relative-major/minor tie behaviour) — detection only
  // needs the implied charted key (D transposed down 2 = C) to be *among*
  // the tied candidates, not the sole winner.
  const tree = {
    "song.cho.txt": Buffer.from("{title: Test Song}\n{key: D}\n{capo: 2}\n[C]Some [F]lyrics [G]here [Am]too"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const crateJson = result.crate.toJSON();

  const mismatches = extractCapoKeyMismatches(crateJson);
  assert.equal(mismatches.length, 1);
  const [item] = mismatches;
  assert.equal(item.id, "song.cho.txt");
  assert.equal(item.currentKey, "D");
  assert.equal(item.suggestedKey, "C");
  assert.equal(item.suggestedTranspose, "+2");
  assert.equal(item.capo, 2);
  assert.deepEqual(item.chordsUsed, ["C", "F", "G", "Am"]);
}

{
  // No capo at all: nothing to revert against, regardless of what the
  // chords say — capo-independence is the whole point of this tool's own
  // {key:}/{capo:} split, so a keyless-of-capo song is never a candidate.
  const tree = {
    "song.cho.txt": Buffer.from("{title: Test Song}\n{key: D}\n[C]Some [F]lyrics [G]here [Am]too"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const mismatches = extractCapoKeyMismatches(result.crate.toJSON());
  assert.equal(mismatches.length, 0);
}

{
  // The authored key already agrees with the chords as charted — a real
  // capo'd song charted the way this tool actually expects, not a mismatch.
  const tree = {
    "song.cho.txt": Buffer.from("{title: Test Song}\n{key: C}\n{capo: 2}\n[C]Some [F]lyrics [G]here [Am]too"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const mismatches = extractCapoKeyMismatches(result.crate.toJSON());
  assert.equal(mismatches.length, 0);
}

/* ---------- setDirectiveValue (SPEC.md §18) ---------- */

{
  // Replaces an existing directive's value in place, keeping its own
  // spelling and touching nothing else on the line.
  const result = setDirectiveValue("{title: A Song}\n{key: D}\n[C]Some lyrics", ["key"], "C");
  assert.equal(result, "{title: A Song}\n{key: C}\n[C]Some lyrics");
}

{
  // Alias support: finds "tr" when "transpose" is the name being searched
  // for's alternate spelling, and keeps that same spelling on replace.
  const result = setDirectiveValue("{title: A Song}\n{tr: -2}\n[C]Some lyrics", ["transpose", "tr"], "+2");
  assert.equal(result, "{title: A Song}\n{tr: +2}\n[C]Some lyrics");
}

{
  // Neither alias present at all: falls back to inserting after the title
  // line, using the first name given as the spelling to insert.
  const result = setDirectiveValue("{title: A Song}\n[C]Some lyrics", ["transpose", "tr"], "+2");
  assert.equal(result, "{title: A Song}\n{transpose: +2}\n[C]Some lyrics");
}

/* ---------- insertKeyDirective (SPEC.md §17) ---------- */

{
  // The common case: a {title:}/{t:} line to insert directly after.
  const result = insertKeyDirective("{title: A Song}\n[C]Some lyrics", "G");
  assert.equal(result, "{title: A Song}\n{key: G}\n[C]Some lyrics");
}

{
  // CRLF is preserved for the line it actually touches — no wholesale
  // normalisation of the rest of the file (st_directive.js's own
  // "operate on the original text directly" discipline, SPEC.md §15).
  const result = insertKeyDirective("{t: A Song}\r\n[C]Some lyrics\r\n", "Em");
  assert.equal(result, "{t: A Song}\r\n{key: Em}\n[C]Some lyrics\r\n");
}

{
  // No title line at all: the directive goes at the very top instead.
  const result = insertKeyDirective("[C]Just chords, no title", "C");
  assert.equal(result, "{key: C}\n[C]Just chords, no title");
}

{
  // Edge case: the title line is the entire file, with no trailing newline
  // of its own to split on — a naive splice would glue the two directives
  // together with no separator at all.
  const result = insertKeyDirective("{title: Only Line}", "D");
  assert.equal(result, "{title: Only Line}\n{key: D}\n");
}

console.log("test-chordpro-crate.mjs: all assertions passed.");
