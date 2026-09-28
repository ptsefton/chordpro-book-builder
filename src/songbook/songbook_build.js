// Build orchestration for the standalone app (SPEC.md §3): folder in,
// ro-crate-metadata.json + the songbook page + ro-crate-preview.html out.
//
// The book's title and the songbook's own filename are the only two things
// a person chooses. Both are recorded in the crate itself — the title as
// the root dataset's `name`, the filename as a File entity the root dataset
// hasPart — so the next visit to the same folder prefills both from
// whatever is already on disk (readBookSettings), with nothing stored
// anywhere else.
//
// No DOM here: everything takes a FileSystemDirectoryHandle-shaped object,
// so the tests can drive it against an in-memory folder.

import { buildCrateFromChordProFolder, GENERATED_FILENAMES } from "./chordpro_crate.js";
import { renderSongbookHtml, renderRedirectHtml, isCanonicalSong } from "./songbook_html.js";
import { toArray, firstValue } from "./crate_index.js";
import { writeFile } from "./fs_helpers.js";

export const CRATE_FILE = "ro-crate-metadata.json";
export const PREVIEW_FILE = "ro-crate-preview.html";
export const DEFAULT_SONGBOOK_FILE = "songbook.html";
const HTML_FORMAT = "text/html";

function rootDatasetOf(crateJson) {
  const graph = Array.isArray(crateJson?.["@graph"]) ? crateJson["@graph"] : [];
  const descriptor = graph.find((e) => e["@id"] === CRATE_FILE);
  const rootId = descriptor ? toArray(descriptor.about)[0]?.["@id"] : "./";
  return graph.find((e) => e["@id"] === (rootId || "./")) || null;
}

// A File entity for the songbook page: encodingFormat text/html, anything
// but the RO-Crate preview itself.
function isSongbookFileEntity(entity) {
  return toArray(entity["@type"]).includes("File")
    && toArray(entity.encodingFormat).includes(HTML_FORMAT)
    && entity["@id"] !== PREVIEW_FILE;
}

// The songbook filename a crate records, or null if it records none (a crate
// built before this app existed always wrote plain songbook.html).
export function songbookFileFromCrate(crateJson) {
  const graph = Array.isArray(crateJson?.["@graph"]) ? crateJson["@graph"] : [];
  const entity = graph.find(isSongbookFileEntity);
  return entity ? entity["@id"] : null;
}

// What to prefill the title/filename fields with for a folder: whatever an
// earlier build recorded, else the folder's own name and songbook.html.
export function readBookSettings(crateJson, folderName) {
  const root = crateJson ? rootDatasetOf(crateJson) : null;
  const title = (root && String(firstValue(root, "name") || "").trim()) || folderName || "Songbook";
  const filename = (crateJson && songbookFileFromCrate(crateJson)) || DEFAULT_SONGBOOK_FILE;
  return { title, filename };
}

// Tidies whatever was typed into the filename field into a plain file name
// in the picked folder, or throws with a message fit to show as-is. Never a
// path (no subfolders), always .html, and never one of the names this app
// writes for its own purposes.
export function normalizeSongbookFilename(raw) {
  let name = String(raw ?? "").trim();
  if (!name) return DEFAULT_SONGBOOK_FILE;
  name = name.replace(/[\\/:*?"<>|]+/g, "-");
  if (!/\.html?$/i.test(name)) name += ".html";
  if (name.startsWith(".")) throw new Error("The songbook filename can't start with a dot.");
  const lower = name.toLowerCase();
  if (lower !== DEFAULT_SONGBOOK_FILE && GENERATED_FILENAMES.has(lower)) {
    throw new Error(`"${name}" is reserved for the RO-Crate files — choose another name.`);
  }
  return name;
}

// Records `filename` as the crate's songbook File entity, replacing any
// earlier one (and its root hasPart reference). Mutates crateJson.
export function recordSongbookFile(crateJson, filename) {
  const graph = crateJson["@graph"];
  const staleIds = new Set(graph.filter(isSongbookFileEntity).map((e) => e["@id"]));
  crateJson["@graph"] = graph.filter((e) => !staleIds.has(e["@id"]));
  const root = rootDatasetOf(crateJson);
  if (root) {
    const parts = toArray(root.hasPart).filter((ref) => !staleIds.has(ref?.["@id"]));
    parts.push({ "@id": filename });
    root.hasPart = parts;
  }
  crateJson["@graph"].push({
    "@id": filename,
    "@type": "File",
    name: "Songbook",
    description: "Interactive, printable songbook generated from the songs and setlists in this crate.",
    encodingFormat: HTML_FORMAT,
  });
  return crateJson;
}

// Writes the three output files for an already-assembled crate: the crate
// itself, the songbook page (under whatever filename the crate records) and
// the RO-Crate preview, which just redirects to the songbook. Used both by a
// full build and by every review tool that patches the crate on disk.
export async function writeOutputs(dirHandle, crateJson, log = () => {}) {
  const songbookFile = songbookFileFromCrate(crateJson) || DEFAULT_SONGBOOK_FILE;
  const songbookHtml = renderSongbookHtml(crateJson);
  await writeFile(dirHandle, CRATE_FILE, JSON.stringify(crateJson, null, 2));
  await writeFile(dirHandle, songbookFile, songbookHtml);
  await writeFile(dirHandle, PREVIEW_FILE, renderRedirectHtml(songbookFile));
  const songCount = crateJson["@graph"]
    .filter((e) => toArray(e["@type"]).includes("MusicComposition") && isCanonicalSong(e)).length;
  log(`Wrote ${songbookFile}, ${CRATE_FILE} and ${PREVIEW_FILE} (${songCount} song(s)).`, "ok");
  return { songbookFile, songbookHtml, songCount };
}

// The whole build: harvest the folder into a crate, record the chosen title
// and filename in it, write everything out. `matchOverrides` is the
// setlist-match resolution from setlist_match_action.js's
// resolveSetlistMatches (SPEC.md §16). Throws if the folder has no songs
// or setlists at all.
export async function buildSongbook(dirHandle, { title, filename, matchOverrides = {}, log = () => {} } = {}) {
  const songbookFile = normalizeSongbookFilename(filename);
  const result = await buildCrateFromChordProFolder(
    dirHandle,
    { rootDataset: { name: title } },
    (msg) => log(msg, /^\s*Warning:/.test(msg) ? "warn" : "muted"),
    { matchOverrides },
  );
  if (!result) {
    throw new Error("No ChordPro song files (.pro/.cho/.cho.txt) or setlist files (.setlist.md) were found in this folder.");
  }
  // A plain, detached copy — the ro-crate library's own getJson() graph is
  // linked (link: true) and not something to go on mutating.
  const crateJson = JSON.parse(JSON.stringify(result.crate.getJson()));
  recordSongbookFile(crateJson, songbookFile);
  const written = await writeOutputs(dirHandle, crateJson, log);
  return { ...result, crateJson, ...written };
}
