// Builds an RO-Crate from a folder of ChordPro song files and Markdown
// setlists, entirely in the browser via the File System Access API. See
// SPEC.md for the design this implements — in particular §4 (file
// discovery), §5 (Song entities), §6 (Setlist/setlist-entry entities), and §7
// (the entity shapes and rdf:Property definitions below mirror that section
// exactly).
//
// This file owns the folder walk and RO-Crate entity assembly. All ChordPro/Markdown parsing
// itself lives in the chordprobook package (see SPEC.md §1/§8) and is not
// duplicated here.

import { ROCrate } from "ro-crate";
import { ChordProSong, parseSetlist, matchEntryToSong, guessKey, Transposer } from "chordprobook";
import { toArray, firstValue } from "./crate_index.js";

export const DEFAULT_SONG_EXTENSIONS = [".pro", ".cho", ".cho.txt"];
export const DEFAULT_SETLIST_SUFFIX = ".setlist.md";

// Files this app writes (or that other RO-Crate tools write) into the
// folder — skipped during the folder walk (isIgnoredName, below) so a
// rebuild never re-ingests a previous build's own output. A songbook saved
// under a custom filename needs no entry here: only song and setlist
// extensions are ever harvested. Exported so fix_st_directive_ui.js's own
// folder walk, and songbook_build.js's filename check, share this same set.
export const GENERATED_FILENAMES = new Set([
  "ro-crate-metadata.json", "ro-crate-metadata.jsonld", "ro-crate-metadata.xlsx", "ro-crate-preview.html",
  "ro-crate-preview_html",
  "additional-ro-crate-metadata.xlsx",
  "songbook.html",
]);
export const CONTROL_FILENAMES = new Set(["config.json"]);

// rdf:Property definitions for the custom fields this app writes (SPEC.md
// §7) — added once, and only for whichever of these keys actually appear
// somewhere in the finished graph (see addUsedPropertyDefinitions). This list is deliberately short: title/key/composer/
// performer/subtitle/a note's own text/the entry-to-song link/the
// setlist-to-entry link/which set an entry belongs to all reuse standard
// schema.org properties instead (name, musicalKey, composer, performer,
// subtitle, text, specializationOf, hasPart — the last two also being what
// expresses a set's own membership in its setlist, and an entry's in its
// set, structurally, rather than as a flat string property — SPEC.md §7).
// What's left has no schema.org equivalent at all: a capo/transpose value,
// and this app's own match-confidence bookkeeping.
const PROPERTY_DEFINITIONS = {
  "custom:capo": { "@id": "arcp://name,custom/terms#capo", "@type": "rdf:Property", name: "Capo" },
  "custom:transpose": { "@id": "arcp://name,custom/terms#transpose", "@type": "rdf:Property", name: "Transpose" },
  "custom:matchStatus": { "@id": "arcp://name,custom/terms#matchStatus", "@type": "rdf:Property", name: "Match Status" },
  "custom:matchCandidates": { "@id": "arcp://name,custom/terms#matchCandidates", "@type": "rdf:Property", name: "Match Candidates" },
  "custom:keyStatus": { "@id": "arcp://name,custom/terms#keyStatus", "@type": "rdf:Property", name: "Key Status" },
};

/* ---------- directory walking (FileSystemDirectoryHandle) ---------- */

function isIgnoredName(name) {
  return name.startsWith(".") || name.startsWith("~$") || GENERATED_FILENAMES.has(name) || CONTROL_FILENAMES.has(name);
}

// Recursively finds every file under `dirHandle`, returning
// { handle, relativePath } where relativePath is "/"-joined and relative to
// `dirHandle` itself. Subfolders carry no structural meaning in this input
// mode (SPEC.md §4/§9) — every matching file anywhere in the tree becomes a
// Song or Setlist regardless of which folder it's in.
async function findFiles(dirHandle, prefix = "") {
  const found = [];
  for await (const entry of dirHandle.values()) {
    if (isIgnoredName(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") found.push(...(await findFiles(entry, relativePath)));
    else if (entry.kind === "file") found.push({ handle: entry, relativePath });
  }
  return found;
}

function matchesAnySuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function titleFromFilename(relativePath, knownSuffixes) {
  const baseName = relativePath.split("/").pop();
  const lower = baseName.toLowerCase();
  const matched = knownSuffixes.find((suffix) => lower.endsWith(suffix));
  return matched ? baseName.slice(0, baseName.length - matched.length) : baseName;
}

// Shared by buildCrateFromChordProFolder and findAmbiguousSetlistMatches
// (SPEC.md §16) — the one folder walk, so the two can never disagree about
// what counts as a song, a setlist, or a song's own title. Reads every
// song file's own text up front (needed either way, to get its title via
// ChordProSong — a song's {title} directive can differ from its filename)
// and hands it back alongside `songs`, so a caller that goes on to build
// full entities (buildCrateFromChordProFolder) doesn't re-read each file a
// second time.
async function harvestFilesAndTitles(rootHandle, opts = {}) {
  const songExtensions = (opts.songExtensions?.length ? opts.songExtensions : DEFAULT_SONG_EXTENSIONS)
    .map((ext) => ext.toLowerCase());
  const setlistSuffix = (opts.setlistSuffix || DEFAULT_SETLIST_SUFFIX).toLowerCase();

  const allFiles = await findFiles(rootHandle);
  const songFiles = [];
  const setlistFiles = [];
  for (const file of allFiles) {
    if (matchesAnySuffix(file.relativePath, [setlistSuffix])) setlistFiles.push(file);
    else if (matchesAnySuffix(file.relativePath, songExtensions)) songFiles.push(file);
  }
  songFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  setlistFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const songs = []; // { id, title } — the list setlist-entry matching (§6.1) resolves against
  const songTexts = new Map();
  for (const { handle, relativePath } of songFiles) {
    const rawText = await (await handle.getFile()).text();
    songTexts.set(relativePath, rawText);
    const parsed = new ChordProSong(rawText);
    const title = parsed.title || titleFromFilename(relativePath, songExtensions);
    songs.push({ id: relativePath, title });
  }

  return { songExtensions, setlistSuffix, songFiles, setlistFiles, songs, songTexts };
}

// How many songs and setlists a folder holds — what the app shows as soon
// as a folder is picked, before anything is built. Same walk as a real
// build, so the two can never disagree.
export async function scanFolder(rootHandle, opts = {}) {
  const { songFiles, setlistFiles } = await harvestFilesAndTitles(rootHandle, opts);
  return { songCount: songFiles.length, setlistCount: setlistFiles.length };
}

/* ---------- Song entities (SPEC.md §5) ---------- */

// Reads whichever ro-crate-metadata.json is already sitting in `rootHandle`,
// if any — a plain, best-effort read.
// Anything short of "valid JSON with a @graph" (missing file, corrupt JSON,
// an unexpected shape) is treated as "nothing to reuse" rather than an
// error — a first-ever build of a fresh folder hits this on every song.
async function readExistingCrateJson(rootHandle) {
  try {
    for await (const entry of rootHandle.values()) {
      if (entry.kind !== "file" || entry.name !== "ro-crate-metadata.json") continue;
      const text = await (await entry.getFile()).text();
      const json = JSON.parse(text);
      return Array.isArray(json && json["@graph"]) ? json : null;
    }
    return null;
  } catch {
    return null;
  }
}

// @id -> { musicalKey, keyStatus } for every canonical song a prior build
// already assigned a guessed-or-confirmed key to (SPEC.md §17) — songs with
// an authored {key:} never appear here, since buildSongEntity never needs to
// "reuse" one: it reads the file's own directive fresh, every time.
function extractPersistedSongKeys(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const persisted = {};
  for (const entity of graph) {
    if (!toArray(entity["@type"]).includes("MusicComposition")) continue;
    if ("specializationOf" in entity || "custom:matchStatus" in entity) continue; // a setlist-entry proxy, not a canonical song
    const keyStatus = firstValue(entity, "custom:keyStatus");
    if (keyStatus !== "guessed" && keyStatus !== "confirmed") continue;
    const musicalKey = firstValue(entity, "musicalKey");
    if (!musicalKey) continue;
    persisted[entity["@id"]] = { musicalKey, keyStatus };
  }
  return persisted;
}

// The canonical entity for one song file: the *only* place its full text
// lives (schema:text) — every setlist entry that performs this song points
// back here rather than carrying its own copy (see buildSetlistEntities).
function buildSongEntity(relativePath, rawText, songExtensions, persistedKeys = {}) {
  const parsed = new ChordProSong(rawText);
  const title = parsed.title || titleFromFilename(relativePath, songExtensions);

  const entity = { "@id": relativePath, "@type": "MusicComposition", name: title, text: rawText };
  if (parsed.key) {
    entity.musicalKey = parsed.key;
  } else {
    // SPEC.md §17: reuse a prior guess/confirmation before ever re-guessing
    // — a human's own reviewed choice has to survive a rebuild the same way
    // an authored {key:} always has.
    const persisted = persistedKeys[relativePath];
    if (persisted) {
      entity.musicalKey = persisted.musicalKey;
      entity["custom:keyStatus"] = persisted.keyStatus;
    } else {
      const guesses = guessKey(parsed.chordsUsed);
      if (guesses.length) {
        entity.musicalKey = guesses[0].key;
        entity["custom:keyStatus"] = "guessed";
      }
    }
  }
  // schema.org's `composer`/`performer` both expect a Person/Organization
  // reference; this app writes the ChordPro directive's free text
  // directly instead of minting a Person entity for either (SPEC.md §5) —
  // a deliberate, documented simplification, not an oversight.
  if (parsed.composer) entity.composer = parsed.composer;
  if (parsed.artist) entity.performer = parsed.artist;
  if (parsed.subtitle) entity.subtitle = parsed.subtitle;
  // A string, not the number ChordProSong itself parses {capo} into
  // (SPEC.md §5) — every other extracted directive here is a plain string
  // already (musicalKey/composer/transpose can all hold non-numeric text,
  // e.g. a transpose target like "Em"), and capo's own crate representation
  // follows that same convention rather than being the one property with a
  // real JS number for a value. This is scoped to the Song entity's own
  // {capo} only — a setlist entry's own capo override (SPEC.md §6, from a
  // completely different parser, Setlist.js) is unaffected and stays a
  // number (see buildSetlistEntities, below).
  if (Number.isInteger(parsed.capo)) entity["custom:capo"] = String(parsed.capo);
  if (parsed.transpose) entity["custom:transpose"] = parsed.transpose;

  return { entity, title };
}

/* ---------- Setlist / setlist-entry entities (SPEC.md §6) ---------- */

// Groups entries into sets (SPEC.md §6) by consecutive runs sharing the
// same (non-empty) entry.setName — an entry with no set at all (setName
// "", from a setlist that never uses "#", or one that hasn't reached its
// first "#" heading yet) is not part of any group and stays a direct child
// of the top-level setlist itself, exactly as every setlist behaved before
// "#" sets existed as their own entities at all. Two "#" sections that
// happen to share a literal name are only treated as one group when
// they're directly adjacent (nothing else could tell them apart from a
// flat list of entries alone without also threading Setlist.js's own line
// position through); a real setlist repeating a set name for two genuinely
// separate sections is an edge case this app doesn't try to disambiguate
// further. Returns an array of either `{ kind: "entry", entry, index }` or
// `{ kind: "set", setName, entries: [{ entry, index }, ...] }`, in file
// order.
function groupEntriesIntoSets(entries) {
  const groups = [];
  let i = 0;
  while (i < entries.length) {
    const { setName } = entries[i];
    if (!setName) {
      groups.push({ kind: "entry", entry: entries[i], index: i });
      i += 1;
      continue;
    }
    const members = [];
    while (i < entries.length && entries[i].setName === setName) {
      members.push({ entry: entries[i], index: i });
      i += 1;
    }
    groups.push({ kind: "set", setName, entries: members });
  }
  return groups;
}

/* ---------- resolving ambiguous matches (SPEC.md §16) ---------- */

// How many leading directory segments `setlistPath` and `candidatePath`
// share — "closest in the tree", PT's own phrasing. Only the directories
// above each file count; the filename itself never does, so two songs in
// the very same folder as the setlist are equally close regardless of
// their own names.
function sharedDirectoryDepth(setlistPath, candidatePath) {
  const setlistDirs = setlistPath.split("/").slice(0, -1);
  const candidateDirs = candidatePath.split("/").slice(0, -1);
  let depth = 0;
  while (depth < setlistDirs.length && depth < candidateDirs.length && setlistDirs[depth] === candidateDirs[depth]) {
    depth += 1;
  }
  return depth;
}

// Ranks a set of ambiguous candidates by path-proximity to the setlist file
// itself, closest first. A stable sort: candidates tied on shared-segment
// count keep whatever relative order they arrived in (matchEntryToSong's
// own scan order) rather than a second, arbitrary tiebreak invented here —
// the explicit index comparison below guarantees that regardless of
// whether the JS engine's own Array#sort happens to be stable.
export function rankCandidatesByPath(setlistPath, candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index, depth: sharedDirectoryDepth(setlistPath, candidate.id) }))
    .sort((a, b) => (b.depth - a.depth) || (a.index - b.index))
    .map((ranked) => ranked.candidate);
}

// The key both a fresh scan (findAmbiguousSetlistMatches) and a previously
// -resolved choice (extractPersistedSetlistMatches) use to recognise "the
// same entry": by content — which setlist file, and its own raw heading
// text — never by comparing "#entry-N"-style @ids directly, since those
// are positional and shift the moment an entry is added, removed, or
// reordered anywhere earlier in the same file (the same reasoning already
// documented for why setNotes/groupEntriesIntoSets key by name rather than
// index, SPEC.md §6).
function matchKey(setlistPath, rawHeading) {
  // JSON.stringify of a pair, not a delimiter-joined string — no separator
  // is needed (and no separator choice, including a literal NUL byte, is
  // provably collision-free without one), and this stays plain, greppable
  // text rather than something standard text tools (grep among them —
  // this file itself briefly stopped matching any grep pattern at all once
  // a real NUL byte was in it) start treating as a binary file.
  return JSON.stringify([setlistPath, rawHeading]);
}

// Reads a previously-built crate (whatever's already sitting in the
// folder) for every ambiguous setlist entry a human has already resolved,
// keyed by matchKey(). Returns a plain object: matchKey(...) -> the chosen
// song's own @id. A prior entity only counts if it actually carries
// specializationOf — an entry that was ambiguous but never resolved (or
// whose review was itself skipped, SPEC.md §16's own soft gate) has
// nothing worth persisting.
export function extractPersistedSetlistMatches(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const persisted = {};
  for (const entity of graph) {
    const id = entity && entity["@id"];
    if (typeof id !== "string") continue;
    const hashIndex = id.indexOf("#entry-");
    if (hashIndex < 0) continue;
    if (firstValue(entity, "custom:matchStatus") !== "ambiguous") continue;
    const specializationOf = toArray(entity.specializationOf)[0];
    const songId = specializationOf && specializationOf["@id"];
    const rawHeading = firstValue(entity, "name");
    if (!songId || !rawHeading) continue;
    persisted[matchKey(id.slice(0, hashIndex), rawHeading)] = songId;
  }
  return persisted;
}

// Which setlist file (and "#" set, if any) each entry @id belongs to —
// structural in the crate (a set/setlist's own hasPart references its
// entries, SPEC.md §6/§7), not a property on the entry itself, so this has
// to be derived by walking every MusicPlaylist entity's own hasPart rather
// than read straight off the entry. Shared by extractReviewableSetlistMatches
// (below) for the same "which gig is this from" context
// findAmbiguousSetlistMatches's own results already carry (there, it's free
// — entry.setName comes straight from parseSetlist — but there's no parser
// to ask once all that's left is the built crate's own JSON-LD).
function buildEntryContextMap(graph) {
  const byId = new Map(graph.map((entity) => [entity["@id"], entity]));
  const context = new Map();
  for (const entity of graph) {
    if (!toArray(entity["@type"]).includes("MusicPlaylist")) continue;
    const id = String(entity["@id"]);
    const hashIndex = id.indexOf("#");
    const setlistPath = hashIndex < 0 ? id : id.slice(0, hashIndex);
    const setName = hashIndex < 0 ? "" : (firstValue(entity, "name") || "");
    for (const ref of toArray(entity.hasPart)) {
      const childId = ref && ref["@id"];
      if (!childId) continue;
      const child = byId.get(childId);
      // A set reference inside the top-level setlist's own hasPart, not an
      // entry — that set's own iteration (above) is what actually attaches
      // context to its entries; skip it here rather than wrongly recording
      // this set's own id as if it were a setName-less entry.
      if (child && toArray(child["@type"]).includes("MusicPlaylist")) continue;
      context.set(childId, { setlistPath, setName });
    }
  }
  return context;
}

// Every setlist entry that was *ever* ambiguous (carries
// custom:matchCandidates, SPEC.md §7), read straight from a crate already
// on disk — for the "I noticed a mistake after building" review, SPEC.md
// §16, as opposed to findAmbiguousSetlistMatches's own pre-build scan
// (above), which only ever surfaces entries not yet resolved at all. Each
// result carries both `currentId` (whatever specializationOf already
// points to — a fresh pick, or one persisted from an earlier build) and
// `recommendedId` (rankCandidatesByPath's own pick, independent of what was
// actually chosen) so a reviewer can see, and change, a decision even when
// it was never wrong in the first place — the two only usually agree.
export function extractReviewableSetlistMatches(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const byId = new Map(graph.map((entity) => [entity["@id"], entity]));
  const context = buildEntryContextMap(graph);
  const results = [];

  for (const entity of graph) {
    const id = entity && entity["@id"];
    if (typeof id !== "string") continue;
    const hashIndex = id.indexOf("#entry-");
    if (hashIndex < 0) continue;
    const candidateRefs = toArray(entity["custom:matchCandidates"]);
    if (!candidateRefs.length) continue;

    const setlistPath = id.slice(0, hashIndex);
    const rawHeading = firstValue(entity, "name") || "";
    const specializationOf = toArray(entity.specializationOf)[0];
    const currentId = (specializationOf && specializationOf["@id"]) || null;
    const entryContext = context.get(id) || { setlistPath, setName: "" };

    const candidates = candidateRefs
      .map((ref) => ref && ref["@id"])
      .filter((candidateId) => typeof candidateId === "string")
      .map((candidateId) => {
        const songEntity = byId.get(candidateId);
        return { id: candidateId, title: (songEntity && firstValue(songEntity, "name")) || candidateId };
      });
    // Candidates are already written closest-first (SPEC.md §7), but
    // re-ranked here too rather than trusted as-is — this function's own
    // job is to tell a reviewer what's *recommended*, and re-deriving it
    // independently is what makes that trustworthy even if some future
    // change ever wrote the list in a different order.
    const recommended = rankCandidatesByPath(setlistPath, candidates)[0];

    results.push({
      entryId: id,
      key: matchKey(setlistPath, rawHeading),
      setlistPath,
      setName: entryContext.setName,
      rawHeading,
      currentId,
      recommendedId: recommended ? recommended.id : null,
      candidates,
    });
  }

  return results;
}

// Every setlist entry that matched no song at all (custom:matchStatus
// "unresolved"), with the setlist (and set) it came from — shown after a
// build so a misspelt heading doesn't go unnoticed. Nothing to choose here,
// unlike an ambiguous match: the fix is in the setlist or song file itself.
export function extractUnresolvedSetlistEntries(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const context = buildEntryContextMap(graph);
  return graph
    .filter((entity) => firstValue(entity, "custom:matchStatus") === "unresolved")
    .map((entity) => {
      const id = String(entity["@id"]);
      const entryContext = context.get(id) || { setlistPath: id.split("#")[0], setName: "" };
      return { entryId: id, rawHeading: firstValue(entity, "name") || "", ...entryContext };
    });
}

// A lightweight pre-scan for the app's own review step
// (SPEC.md §16), run before the real build: which setlist entries would
// come out "ambiguous", and what their path-proximity-ranked candidates
// would be. Shares harvestFilesAndTitles with buildCrateFromChordProFolder
// so the two can never disagree about what a song or a setlist even is —
// but doesn't build a single crate entity itself, since all that's needed
// here is `songs` and each setlist's own parsed entries.
export async function findAmbiguousSetlistMatches(rootHandle, opts = {}) {
  const { setlistFiles, songs } = await harvestFilesAndTitles(rootHandle, opts);
  const entries = [];

  for (const { handle, relativePath } of setlistFiles) {
    const rawText = await (await handle.getFile()).text();
    const { entries: setlistEntries } = parseSetlist(rawText);
    for (const entry of setlistEntries) {
      const match = matchEntryToSong(entry.rawHeading, songs);
      if (match.matchStatus !== "ambiguous") continue;
      const ranked = rankCandidatesByPath(relativePath, match.candidates);
      entries.push({
        key: matchKey(relativePath, entry.rawHeading),
        setlistPath: relativePath,
        setName: entry.setName || "",
        rawHeading: entry.rawHeading,
        candidates: ranked.map((candidate) => ({ id: candidate.id, title: candidate.title })),
      });
    }
  }

  return { entries, songs };
}

function buildSetlistEntities(relativePath, rawText, songs, setlistSuffix, overrides = {}) {
  const { title, entries, setNotes } = parseSetlist(rawText);
  const entryEntities = [];
  const entryRefsByIndex = [];
  const matchStatuses = [];

  entries.forEach((entry, index) => {
    const entryId = `${relativePath}#entry-${index + 1}`;
    const match = matchEntryToSong(entry.rawHeading, songs);
    matchStatuses.push(match.matchStatus);

    // A lightweight MusicComposition "proxy" for this one performance slot,
    // linked to the canonical Song it performs via specializationOf rather
    // than duplicating any of that Song's own data. Which set (if any) this
    // entry belongs to is expressed structurally now, via which
    // MusicPlaylist's own hasPart references it (below) — not as a property
    // on the entry itself (superseded custom:setName, SPEC.md §6/§7).
    const entryEntity = {
      "@id": entryId,
      "@type": "MusicComposition",
      name: entry.rawHeading,
      "custom:matchStatus": match.matchStatus,
    };
    if (entry.transpose !== undefined) entryEntity["custom:transpose"] = entry.transpose;
    // A number here, not the string a Song entity's own {capo} becomes
    // (buildSongEntity, above) — this comes from Setlist.js's own inline
    // `{capo: N}` override parsing (SPEC.md §6), a different parser with no
    // string-everywhere convention of its own to match, and this value is
    // only ever read back as a number (songbook_html.js's own entriesById).
    if (Number.isInteger(entry.capo)) entryEntity["custom:capo"] = entry.capo;
    // `text`, not `description`: a performance note can itself be Markdown
    // (chordprosite's own sample setlist already mixed blockquote syntax
    // with **bold** — SPEC.md §6), and songbook_html.js renders it as such
    // (SPEC.md §6.2) — `description` is conventionally a short plain-text
    // summary, not markup meant for rendering. This is a deliberate
    // overload of the same property name the canonical Song entity uses for
    // its own, differently-meant, verbatim ChordPro source (SPEC.md §5/§7)
    // — an entry is always distinguishable from a canonical Song by @id
    // shape regardless (an entry's own always contains "#entry-"), not by
    // whether `text` happens to be present, which is what makes reusing the
    // name safe here.
    if (entry.notes) entryEntity.text = entry.notes;

    // SPEC.md §16 — path-proximity replaces matchEntryToSong's own
    // placeholder first-candidate pick for an ambiguous match, unless a
    // human has already resolved this exact ambiguity (by content, not
    // @id position — matchKey's own comment) via the app's
    // app's own review step, in which case that choice wins instead.
    let resolvedSong = match.song;
    let candidates = match.candidates;
    if (match.matchStatus === "ambiguous") {
      candidates = rankCandidatesByPath(relativePath, match.candidates);
      const overrideId = overrides[matchKey(relativePath, entry.rawHeading)];
      resolvedSong = candidates.find((candidate) => candidate.id === overrideId) || candidates[0];
    }
    if (resolvedSong) entryEntity.specializationOf = { "@id": resolvedSong.id };
    if (candidates.length) entryEntity["custom:matchCandidates"] = candidates.map((c) => ({ "@id": c.id }));

    entryEntities.push(entryEntity);
    entryRefsByIndex.push({ "@id": entryId });
  });

  // One nested MusicPlaylist per "#" set (SPEC.md §6), each with its own
  // hasPart pointing at that set's own entries — the top-level setlist's own
  // hasPart then points at a mix of these set entities and any setName-less
  // entries, in original file order. A setlist that never uses "#" at all
  // produces zero set entities and an unchanged, flat top-level hasPart —
  // this is a strict superset of the old behaviour, not a replacement for
  // it in the common case. @id numbering is this loop's own 1-based count of
  // sets actually built, not tied to anything Setlist.js itself tracks.
  const setEntities = [];
  const topLevelRefs = [];
  let setNumber = 0;
  for (const group of groupEntriesIntoSets(entries)) {
    if (group.kind === "entry") {
      topLevelRefs.push(entryRefsByIndex[group.index]);
      continue;
    }
    setNumber += 1;
    const setId = `${relativePath}#set-${setNumber}`;
    const setEntity = {
      "@id": setId,
      "@type": "MusicPlaylist",
      name: group.setName,
      hasPart: group.entries.map(({ index }) => entryRefsByIndex[index]),
    };
    // Freeform text between the "#" heading and this set's own first entry
    // (e.g. "Tune guitars to drop D now") — `text`, not `description`, for
    // the same reason as an entry's own note above: it can be Markdown, and
    // is rendered as such (SPEC.md §6.2).
    if (setNotes[group.setName]) setEntity.text = setNotes[group.setName];
    setEntities.push(setEntity);
    topLevelRefs.push({ "@id": setId });
  }

  const setlistEntity = {
    "@id": relativePath,
    "@type": "MusicPlaylist",
    name: title || titleFromFilename(relativePath, [setlistSuffix]),
  };
  if (topLevelRefs.length) setlistEntity.hasPart = topLevelRefs;

  return { setlistEntity, setEntities, entryEntities, matchStatuses };
}

/* ---------- key guessing and review (SPEC.md §17) ---------- */

// Every canonical song carrying a custom:keyStatus at all — "guessed" and
// "confirmed" alike, so a prior review is always revisitable, not only a
// still-unreviewed guess (same convention as extractReviewableSetlistMatches,
// above) — for the "Review guessed keys…" button, read straight from a crate
// already on disk. Candidates are re-derived on the spot from the entity's
// own `text` (its full, verbatim source — SPEC.md §5/§7) via chordprobook's
// own ChordProSong/guessKey, rather than trusting anything persisted in the
// crate itself: this app doesn't persist the candidate breakdown at all
// (SPEC.md §17's own "Deferred" note), and re-deriving is cheap regardless.
export function extractReviewableSongKeys(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const results = [];
  for (const entity of graph) {
    if (!toArray(entity["@type"]).includes("MusicComposition")) continue;
    if ("specializationOf" in entity || "custom:matchStatus" in entity) continue;
    const keyStatus = firstValue(entity, "custom:keyStatus");
    if (keyStatus !== "guessed" && keyStatus !== "confirmed") continue;

    const text = firstValue(entity, "text") || "";
    const parsed = new ChordProSong(text);
    results.push({
      id: entity["@id"],
      title: firstValue(entity, "name") || entity["@id"],
      currentKey: firstValue(entity, "musicalKey") || "",
      keyStatus,
      // The song's own chords, first-occurrence order (chordprobook's own
      // SPEC.md §3.1) — shown alongside the candidates in the review modal
      // so a reviewer has something to actually judge a guess against,
      // rather than choosing blind between bare key names.
      chordsUsed: parsed.chordsUsed,
      candidates: guessKey(parsed.chordsUsed),
    });
  }
  return results;
}

// Detects a song where the chord shapes actually written down don't match
// the charted `{key:}` a human typed, but DO match that key transposed down
// by the song's own `{capo:}` — i.e. someone charted in (say) C, capped up
// 2 frets, and typed "D" as the key because D is what comes out the
// speaker, rather than following this tool's own convention (docs/
// chordpro-format.md: `{key:}` is the charted/shape key, capo is
// independent, sounding key = charted key transposed by capo). Only ever
// flags songs that already have both an authored key AND a capo — no
// capo, nothing to revert against; no key, nothing to compare (that's
// extractReviewableSongKeys' own job instead, above).
export function detectCapoKeyMismatch(entity) {
  const capo = parseInt(firstValue(entity, "custom:capo"), 10);
  if (!Number.isInteger(capo) || capo <= 0) return null;
  const authoredKey = firstValue(entity, "musicalKey");
  if (!authoredKey) return null;
  const text = firstValue(entity, "text") || "";
  const parsed = new ChordProSong(text);
  const guesses = guessKey(parsed.chordsUsed);
  if (!guesses.length) return null;
  // The chords already agree with the authored key as written — nothing to fix.
  if (guesses.some((g) => g.key === authoredKey)) return null;
  const impliedChartedKey = Transposer.transposeKey(authoredKey, -capo);
  if (!impliedChartedKey) return null;
  // The chords only make sense as the authored key shifted down by the
  // capo — i.e. this song's real charted key — do they agree with THAT?
  if (!guesses.some((g) => g.key === impliedChartedKey)) return null;
  return { currentKey: authoredKey, suggestedKey: impliedChartedKey, suggestedTranspose: `+${capo}`, capo };
}

// Same read-straight-from-the-on-disk-crate convention as
// extractReviewableSongKeys, above — for the "Normalize capos and keys…"
// button (SPEC.md §18). Only canonical MusicComposition song entities are
// candidates (never a setlist entry's own capo override), same filter
// extractReviewableSongKeys applies.
export function extractCapoKeyMismatches(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  const results = [];
  for (const entity of graph) {
    if (!toArray(entity["@type"]).includes("MusicComposition")) continue;
    if ("specializationOf" in entity || "custom:matchStatus" in entity) continue;
    const mismatch = detectCapoKeyMismatch(entity);
    if (!mismatch) continue;
    const text = firstValue(entity, "text") || "";
    const parsed = new ChordProSong(text);
    results.push({
      id: entity["@id"],
      title: firstValue(entity, "name") || entity["@id"],
      chordsUsed: parsed.chordsUsed,
      ...mismatch,
    });
  }
  return results;
}

// Inserts `{<directiveName>: <value>}` directly after a song's own
// {title:}/{t:} line (or at the very top of the file, if it has neither).
// Touches nothing else in the file: no re-tidying, no line-ending
// normalisation beyond the one inserted line — the same "operate on the
// original text directly" discipline st_directive.js's own applyChoices
// follows (SPEC.md §15), for the same reason: a write-back a human didn't
// ask for, anywhere outside the one line this is actually changing, is a
// worse outcome than a slightly odd edge case in how the new line joins in.
function insertDirectiveAfterTitle(rawText, directiveName, value) {
  const titleLineRe = /^[ \t]*\{[ \t]*(?:t|title)[ \t]*:[^}]*\}[ \t]*(\r?\n)?/im;
  const match = rawText.match(titleLineRe);
  const directiveLine = `{${directiveName}: ${value}}`;
  if (!match) return `${directiveLine}\n${rawText}`;
  const insertAt = match.index + match[0].length;
  const prefix = match[1] ? "" : "\n"; // the title line had no trailing newline of its own to split on
  return rawText.slice(0, insertAt) + prefix + directiveLine + "\n" + rawText.slice(insertAt);
}

// Used only for a song whose file has no {key:} of its own to begin with
// (SPEC.md §17), so there is never an existing directive to find or
// replace, only a place to add one.
export function insertKeyDirective(rawText, keyValue) {
  return insertDirectiveAfterTitle(rawText, "key", keyValue);
}

// Replaces an existing directive's value in place — trying every name in
// `directiveNames` in turn (e.g. ["transpose", "tr"], since either spelling
// is valid chordpro and this must find whichever one a given file actually
// uses — SPEC.md §18), keeping the directive's own original spelling/casing
// and touching nothing else on the line. Falls back to
// insertDirectiveAfterTitle (using the first name as the canonical spelling
// to insert) only when none of the aliases are present at all.
export function setDirectiveValue(rawText, directiveNames, value) {
  const names = Array.isArray(directiveNames) ? directiveNames : [directiveNames];
  const namesPattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const directiveRe = new RegExp(`^([ \t]*\{[ \t]*(?:${namesPattern})[ \t]*:)[^}]*(\})`, "im");
  if (directiveRe.test(rawText)) return rawText.replace(directiveRe, `$1 ${value}$2`);
  return insertDirectiveAfterTitle(rawText, names[0], value);
}

/* ---------- rdf:Property definitions (SPEC.md §7) ---------- */

function addUsedPropertyDefinitions(crate) {
  const used = new Set();
  for (const entity of crate.graph) {
    for (const key of Object.keys(entity)) {
      if (PROPERTY_DEFINITIONS[key]) used.add(key);
    }
  }
  for (const key of used) crate.addEntity(PROPERTY_DEFINITIONS[key]);
}

/* ---------- root dataset ---------- */

// Deliberately minimal — just enough for a valid, describable root dataset:
// the book title as `name`, a description and a date. Creators and a
// metadata licence could be added here if a real build turns out to need
// them.
function applyRootDataset(crate, config) {
  const rootDataset = (config && typeof config.rootDataset === "object" && config.rootDataset) || {};

  crate.rootDataset.name =
    (typeof rootDataset.name === "string" && rootDataset.name.trim()) || "Songbook";
  crate.rootDataset.description =
    (typeof rootDataset.description === "string" && rootDataset.description.trim())
    || "RO-Crate generated from ChordPro song and setlist files.";

  const declaredDate = typeof rootDataset.datePublished === "string" ? rootDataset.datePublished.trim() : "";
  crate.rootDataset.datePublished = /^\d{4}-\d{2}-\d{2}$/.test(declaredDate)
    ? declaredDate
    : new Date().toISOString().split("T")[0];
}

/* ---------- top-level orchestration ---------- */

// Builds an RO-Crate from `rootHandle` (a FileSystemDirectoryHandle scanned
// recursively for song and setlist files — SPEC.md §4). `config` is
// { rootDataset: { name, description, datePublished } }, all optional.
// `onProgress(message)` receives human-readable progress/warning lines
// (severity is conveyed by the message text — a "Warning:" prefix — not by
// a separate argument).
// `opts.songExtensions` / `opts.setlistSuffix` override the defaults
// (SPEC.md §4's configurable extensions). `opts.matchOverrides` is a plain
// object, matchKey(...) -> chosen song @id, for any ambiguous entry the
// app has already resolved (a fresh pick, or one persisted
// from an earlier build — SPEC.md §16); anything not in this object falls
// back to the path-proximity default.
//
// Returns { crate, songCount, setlistCount, unresolvedCount, ambiguousCount },
// or null if the folder contains no matching song or setlist files at all.
export async function buildCrateFromChordProFolder(rootHandle, config, onProgress = () => {}, opts = {}) {
  const { songExtensions, setlistSuffix, songFiles, setlistFiles, songs, songTexts } =
    await harvestFilesAndTitles(rootHandle, opts);
  const matchOverrides = opts.matchOverrides || {};

  if (songFiles.length === 0 && setlistFiles.length === 0) return null;

  const priorCrateJson = await readExistingCrateJson(rootHandle);
  const persistedKeys = priorCrateJson ? extractPersistedSongKeys(priorCrateJson) : {};

  const crate = new ROCrate({ array: true, link: true });
  crate.addContext({ custom: "arcp://name,custom/terms#" });
  applyRootDataset(crate, config);

  onProgress(`Found ${songFiles.length} song file(s) and ${setlistFiles.length} setlist file(s).`);

  const rootHasPart = [];

  for (const { relativePath } of songFiles) {
    const rawText = songTexts.get(relativePath);
    const { entity, title } = buildSongEntity(relativePath, rawText, songExtensions, persistedKeys);
    crate.addEntity(entity);
    rootHasPart.push({ "@id": relativePath });
    onProgress(`  Song: ${relativePath} (${title})`);
  }

  let unresolvedCount = 0;
  let ambiguousCount = 0;

  for (const { handle, relativePath } of setlistFiles) {
    const rawText = await (await handle.getFile()).text();
    const { setlistEntity, setEntities, entryEntities, matchStatuses } =
      buildSetlistEntities(relativePath, rawText, songs, setlistSuffix, matchOverrides);
    for (const entryEntity of entryEntities) crate.addEntity(entryEntity);
    for (const setEntity of setEntities) crate.addEntity(setEntity);
    crate.addEntity(setlistEntity);
    rootHasPart.push({ "@id": relativePath });

    for (const status of matchStatuses) {
      if (status === "unresolved") unresolvedCount += 1;
      if (status === "ambiguous") ambiguousCount += 1;
    }
    onProgress(`  Setlist: ${relativePath} (${entryEntities.length} entr${entryEntities.length === 1 ? "y" : "ies"})`);
  }

  if (unresolvedCount > 0) {
    onProgress(`  Warning: ${unresolvedCount} setlist entr${unresolvedCount === 1 ? "y" : "ies"} could not be matched to a song.`);
  }
  if (ambiguousCount > 0) {
    onProgress(`  Note: ${ambiguousCount} setlist entr${ambiguousCount === 1 ? "y" : "ies"} matched more than one song — ` +
      "resolved via path-proximity or a reviewed choice; see custom:matchCandidates on each entry.");
  }

  crate.rootDataset.hasPart = rootHasPart;
  addUsedPropertyDefinitions(crate);

  return { crate, songCount: songFiles.length, setlistCount: setlistFiles.length, unresolvedCount, ambiguousCount };
}
