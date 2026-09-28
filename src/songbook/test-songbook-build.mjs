// Tests for songbook_build.js — the app's build path end to end (folder in,
// crate + songbook + preview out), the title/filename round trip through
// the crate, and the small chordpro_crate.js helpers the app's front page
// uses (scanFolder, extractUnresolvedSetlistEntries).
import assert from "node:assert/strict";
import {
  buildSongbook, writeOutputs, readBookSettings, normalizeSongbookFilename, recordSongbookFile,
  songbookFileFromCrate, CRATE_FILE, PREVIEW_FILE,
} from "./songbook_build.js";
import { scanFolder, extractUnresolvedSetlistEntries, extractPersistedSetlistMatches } from "./chordpro_crate.js";
import { readJsonFromFolder } from "./fs_helpers.js";

/* ---------- a read/write, nested, in-memory FileSystemDirectoryHandle ---------- */

function notFound(name) {
  const e = new Error(`${name} not found`);
  e.name = "NotFoundError";
  return e;
}

// `tree` is { name: "text" | { ...subtree } }.
function memoryFolder(tree, name = "songs") {
  const children = new Map();
  for (const [childName, value] of Object.entries(tree)) {
    children.set(childName, typeof value === "string" ? memoryFile(childName, value) : memoryFolder(value, childName));
  }
  return {
    kind: "directory",
    name,
    children,
    async *values() { yield* children.values(); },
    async getDirectoryHandle(child, { create = false } = {}) {
      if (!children.has(child)) {
        if (!create) throw notFound(child);
        children.set(child, memoryFolder({}, child));
      }
      return children.get(child);
    },
    async getFileHandle(child, { create = false } = {}) {
      if (!children.has(child)) {
        if (!create) throw notFound(child);
        children.set(child, memoryFile(child, ""));
      }
      return children.get(child);
    },
    read(child) { return children.get(child)?.contents; },
  };
}

function memoryFile(name, contents) {
  const file = {
    kind: "file",
    name,
    contents,
    async getFile() { return new File([file.contents], name); },
    async createWritable() {
      return {
        async write(data) { file.contents = typeof data === "string" ? data : new TextDecoder().decode(data); },
        async close() {},
      };
    },
  };
  return file;
}

const SONGS = {
  "Amazing Grace.cho": "{title: Amazing Grace}\n{key: G}\n[G]Amazing [C]grace, how [G]sweet the [D]sound",
  covers: { "Paper Boats.cho": "{title: Paper Boats}\n[C]Paper [F]boats [G]float" },
  originals: {
    "Paper Boats.cho": "{title: Paper Boats}\n[D]Paper [G]boats [A]sink",
    "gig.setlist.md": "{title: Friday}\n\n## Paper Boats\n\n## Amazing Grace\n\n## Song Nobody Wrote\n",
  },
};

/* ---------- normalizeSongbookFilename ---------- */

assert.equal(normalizeSongbookFilename(""), "songbook.html");
assert.equal(normalizeSongbookFilename("   "), "songbook.html");
assert.equal(normalizeSongbookFilename("band book"), "band book.html");
assert.equal(normalizeSongbookFilename("Band.HTML"), "Band.HTML");
assert.equal(normalizeSongbookFilename("gigs/2024"), "gigs-2024.html"); // never a path
assert.equal(normalizeSongbookFilename("songbook.html"), "songbook.html");
assert.throws(() => normalizeSongbookFilename(".hidden"), /dot/);
assert.throws(() => normalizeSongbookFilename("ro-crate-preview.html"), /reserved/);
assert.throws(() => normalizeSongbookFilename("RO-Crate-Preview"), /reserved/);

/* ---------- readBookSettings ---------- */

assert.deepEqual(readBookSettings(null, "My Songs"), { title: "My Songs", filename: "songbook.html" });
// A crate from before this app: a name, but no songbook File entity.
assert.deepEqual(
  readBookSettings({ "@graph": [{ "@id": "./", "@type": "Dataset", name: ["Old Book"] }] }, "folder"),
  { title: "Old Book", filename: "songbook.html" },
);

/* ---------- scanFolder / building ---------- */

{
  const folder = memoryFolder(SONGS);
  assert.deepEqual(await scanFolder(folder), { songCount: 3, setlistCount: 1 });

  const messages = [];
  const result = await buildSongbook(folder, {
    title: "Friday Band",
    filename: "friday",
    log: (msg, level) => messages.push({ msg, level }),
  });
  assert.equal(result.songbookFile, "friday.html");
  assert.equal(result.songCount, 3);

  // All three outputs are written; the preview points at the chosen file.
  const crateOnDisk = JSON.parse(folder.read(CRATE_FILE));
  assert.ok(folder.read("friday.html").includes("<title>Friday Band</title>"));
  assert.ok(folder.read(PREVIEW_FILE).includes('url=friday.html'));
  assert.equal(folder.read("songbook.html"), undefined);
  assert.ok(messages.some((m) => m.level === "ok" && m.msg.includes("friday.html")));

  // The crate records both choices, so the next visit prefills them.
  assert.deepEqual(readBookSettings(crateOnDisk, "songs"), { title: "Friday Band", filename: "friday.html" });
  const root = crateOnDisk["@graph"].find((e) => e["@id"] === "./");
  assert.ok(root.hasPart.some((ref) => ref["@id"] === "friday.html"));
  const fileEntity = crateOnDisk["@graph"].find((e) => e["@id"] === "friday.html");
  assert.equal(fileEntity["@type"], "File");
  assert.equal(fileEntity.encodingFormat, "text/html");

  // The one entry that matches nothing is reported with its setlist.
  assert.deepEqual(
    extractUnresolvedSetlistEntries(crateOnDisk).map(({ rawHeading, setlistPath }) => ({ rawHeading, setlistPath })),
    [{ rawHeading: "Song Nobody Wrote", setlistPath: "originals/gig.setlist.md" }],
  );

  // "Paper Boats" is ambiguous; path-proximity picks the one next to the setlist.
  const entry = crateOnDisk["@graph"].find((e) => e.name === "Paper Boats" && String(e["@id"]).includes("#entry-"));
  assert.equal(entry["custom:matchStatus"], "ambiguous");
  assert.equal(entry.specializationOf["@id"], "originals/Paper Boats.cho");

  // Rebuilding under a new name and with a human's override: exactly one
  // songbook File entity afterwards, the old page left alone on disk.
  const [key] = Object.keys(extractPersistedSetlistMatches(crateOnDisk));
  await buildSongbook(folder, {
    title: "Friday Band",
    filename: "songbook.html",
    matchOverrides: { [key]: "covers/Paper Boats.cho" },
  });
  const rebuilt = JSON.parse(folder.read(CRATE_FILE));
  assert.equal(rebuilt["@graph"].filter((e) => e["@type"] === "File").length, 1);
  assert.equal(songbookFileFromCrate(rebuilt), "songbook.html");
  assert.ok(folder.read("friday.html"));
  assert.ok(folder.read(PREVIEW_FILE).includes('url=songbook.html'));
  const rebuiltEntry = rebuilt["@graph"].find((e) => e["@id"] === entry["@id"]);
  assert.equal(rebuiltEntry.specializationOf["@id"], "covers/Paper Boats.cho");

  // writeOutputs (what every review tool calls after patching the crate)
  // re-renders under whatever filename the crate records.
  const patched = await readJsonFromFolder(folder, CRATE_FILE);
  patched["@graph"].find((e) => e["@id"] === "./").name = "Renamed";
  const written = await writeOutputs(folder, patched);
  assert.equal(written.songbookFile, "songbook.html");
  assert.ok(folder.read("songbook.html").includes("<title>Renamed</title>"));
}

{
  // recordSongbookFile replaces, never accumulates.
  const crate = { "@graph": [{ "@id": "./", "@type": "Dataset", hasPart: [{ "@id": "a.cho" }] }] };
  recordSongbookFile(crate, "one.html");
  recordSongbookFile(crate, "two.html");
  const root = crate["@graph"].find((e) => e["@id"] === "./");
  assert.deepEqual(root.hasPart, [{ "@id": "a.cho" }, { "@id": "two.html" }]);
  assert.equal(crate["@graph"].length, 2);
}

{
  // A folder with nothing to build is an error, not an empty songbook.
  const folder = memoryFolder({ "notes.txt": "hello" });
  await assert.rejects(() => buildSongbook(folder, { title: "x", filename: "x" }), /No ChordPro song files/);
  assert.equal(folder.read(CRATE_FILE), undefined);
}

console.log("test-songbook-build.mjs: all assertions passed.");
