// The songbook builder app: pick a folder, name the book, make it — then
// review whatever the build had to guess. Everything that actually builds
// or patches a songbook lives in src/chordpro-input/; this file is only the
// page around it.
//
// Under the hood each build writes an RO-Crate (ro-crate-metadata.json)
// alongside the songbook page, and every review tool works from that crate
// — but the page never needs to say so.

import { scanFolder, extractReviewableSetlistMatches, extractReviewableSongKeys, extractCapoKeyMismatches,
  extractUnresolvedSetlistEntries } from "../src/chordpro-input/chordpro_crate.js";
import { buildSongbook, readBookSettings, normalizeSongbookFilename, songbookFileFromCrate, CRATE_FILE,
  DEFAULT_SONGBOOK_FILE } from "../src/chordpro-input/songbook_build.js";
import { bookTitleFromCrate, isCanonicalSong } from "../src/chordpro-input/songbook_html.js";
import { verifyPermission, readJsonFromFolder, fileExists } from "../src/chordpro-input/fs_helpers.js";
import { resolveSetlistMatches, reviewSetlistMatches } from "../src/chordpro-input/setlist_match_action.js";
import { reviewKeyGuesses } from "../src/chordpro-input/key_review_action.js";
import { normalizeCapoKeys } from "../src/chordpro-input/normalize_capo_key_action.js";
import { fixStDirectives, findStDirectiveHits } from "../src/chordpro-input/fix_st_directive_action.js";
import { openModal } from "./modal.js";
import { loadLastFolder, saveLastFolder } from "./folder_store.js";

const $ = (id) => document.getElementById(id);
const show = (el, visible = true) => el.classList.toggle("hidden", !visible);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let dirHandle = null;
let crateJson = null; // the crate currently on disk in dirHandle, if any
let busy = false;

/* ---------- log ---------- */

function log(message, level = "info") {
  const item = document.createElement("li");
  item.className = `log-${level}`;
  item.textContent = message;
  $("log").appendChild(item);
  if (level === "err") {
    $("log-details").open = true;
    item.scrollIntoView({ block: "nearest" });
  }
}

const toolContext = () => ({ dirHandle, log, openModal });

/* ---------- busy state ---------- */

async function whileBusy(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  const buttons = [...document.querySelectorAll("main button")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    log(e && e.message ? e.message : String(e), "err");
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    document.body.classList.remove("busy");
    busy = false;
  }
}

/* ---------- step 1: folder ---------- */

async function pickFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "chordpro-songbook", mode: "readwrite" });
  } catch (e) {
    if (e && e.name === "AbortError") return; // picker cancelled
    throw e;
  }
  await openFolder(handle);
}

async function openFolder(handle) {
  if (!(await verifyPermission(handle, true))) {
    log(`Permission to read and write “${handle.name}” was not granted.`, "err");
    return;
  }
  dirHandle = handle;
  await saveLastFolder(handle);
  show($("reopen-folder"), false);
  log(`Opened folder “${handle.name}”.`);

  const { songCount, setlistCount } = await scanFolder(handle);
  const summary = $("folder-summary");
  show(summary);
  if (!songCount && !setlistCount) {
    summary.textContent = `“${handle.name}” has no ChordPro songs or setlists in it. Choose another folder.`;
    summary.classList.add("error");
    show($("step-book"), false);
    show($("step-result"), false);
    return;
  }
  summary.classList.remove("error");
  summary.textContent = `“${handle.name}”: ${plural(songCount, "song")}` +
    (setlistCount ? `, ${plural(setlistCount, "setlist")}.` : ".");

  crateJson = null;
  try {
    crateJson = await readJsonFromFolder(handle, CRATE_FILE);
  } catch (e) {
    log(`Ignoring the existing ${CRATE_FILE}: ${e.message}`, "warn");
  }
  const settings = readBookSettings(crateJson, handle.name);
  $("book-title").value = settings.title;
  $("book-file").value = settings.filename;
  show($("book-error"), false);
  show($("step-book"));

  if (crateJson && (await fileExists(handle, songbookFileFromCrate(crateJson) || DEFAULT_SONGBOOK_FILE))) {
    await showResult({ fresh: false });
  } else {
    crateJson = null;
    show($("step-result"), false);
  }
  $("book-title").focus();
}

/* ---------- step 2: make ---------- */

async function makeSongbook() {
  const title = $("book-title").value.trim();
  let filename;
  try {
    if (!title) throw new Error("Give the songbook a title.");
    filename = normalizeSongbookFilename($("book-file").value);
  } catch (e) {
    $("book-error").textContent = e.message;
    show($("book-error"));
    return;
  }
  show($("book-error"), false);
  $("book-file").value = filename;

  if (!(await verifyPermission(dirHandle, true))) {
    log("Permission to write to the folder was not granted.", "err");
    return;
  }

  const previousFile = crateJson ? songbookFileFromCrate(crateJson) : null;
  log(`Making “${title}”…`);
  const matchOverrides = await resolveSetlistMatches(dirHandle, toolContext());
  const result = await buildSongbook(dirHandle, { title, filename, matchOverrides, log });
  crateJson = result.crateJson;

  // Compared case-insensitively: on macOS/Windows "Songbook.html" and
  // "songbook.html" are the same file, just rewritten.
  if (previousFile && previousFile.toLowerCase() !== filename.toLowerCase()
    && (await fileExists(dirHandle, previousFile))) {
    log(`The earlier songbook, ${previousFile}, is still in the folder — delete it if you no longer need it.`, "info");
  }
  await showResult({ fresh: true });
}

/* ---------- step 3: result and follow-up checks ---------- */

function currentSongbookFile() {
  return (crateJson && songbookFileFromCrate(crateJson)) || DEFAULT_SONGBOOK_FILE;
}

function crateCounts(json) {
  const graph = json["@graph"] || [];
  const types = (e) => [].concat(e["@type"] || []);
  const songs = graph.filter((e) => types(e).includes("MusicComposition") && isCanonicalSong(e)).length;
  const setlists = graph.filter((e) => types(e).includes("MusicPlaylist") && !String(e["@id"]).includes("#")).length;
  return { songs, setlists };
}

async function showResult({ fresh }) {
  const { songs, setlists } = crateCounts(crateJson);
  const counts = plural(songs, "song") + (setlists ? `, ${plural(setlists, "setlist")}` : "");
  $("result-summary").textContent = fresh
    ? `Saved “${bookTitleFromCrate(crateJson)}” as ${currentSongbookFile()} (${counts}).`
    : `This folder already has a songbook: ${currentSongbookFile()} (${counts}). ` +
      "Make it again to pick up any changes to your songs.";
  show($("step-result"));
  await renderChecks();
  if (fresh) $("step-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function checkItem({ text, detail, buttonLabel, onClick }) {
  const item = document.createElement("li");
  const body = document.createElement("div");
  const line = document.createElement("div");
  line.textContent = text;
  body.appendChild(line);
  if (detail) {
    const extra = document.createElement(Array.isArray(detail) ? "ul" : "div");
    extra.className = "check-detail";
    if (Array.isArray(detail)) {
      detail.forEach((d) => { const li = document.createElement("li"); li.textContent = d; extra.appendChild(li); });
    } else {
      extra.textContent = detail;
    }
    body.appendChild(extra);
  }
  item.appendChild(body);
  if (buttonLabel) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = buttonLabel;
    button.addEventListener("click", () => whileBusy(onClick));
    item.appendChild(button);
  }
  return item;
}

async function renderChecks() {
  const list = $("checks");
  list.replaceChildren();

  const keys = extractReviewableSongKeys(crateJson);
  const guessed = keys.filter((k) => k.keyStatus === "guessed").length;
  if (keys.length) {
    list.appendChild(checkItem({
      text: guessed
        ? `${plural(guessed, "song has", "songs have")} no {key:} — the key was guessed from the chords.`
        : `${plural(keys.length, "song has", "songs have")} a key you confirmed earlier.`,
      buttonLabel: guessed ? "Review keys…" : "Change keys…",
      onClick: () => runTool(reviewKeyGuesses),
    }));
  }

  const capoMismatches = extractCapoKeyMismatches(crateJson);
  if (capoMismatches.length) {
    list.appendChild(checkItem({
      text: `${plural(capoMismatches.length, "song looks", "songs look")} like the key was written as it sounds with the capo on, not as played.`,
      buttonLabel: "Review capos and keys…",
      onClick: () => runTool(normalizeCapoKeys),
    }));
  }

  const matches = extractReviewableSetlistMatches(crateJson);
  if (matches.length) {
    list.appendChild(checkItem({
      text: `${plural(matches.length, "setlist entry", "setlist entries")} matched more than one song; the closest was used unless you chose otherwise.`,
      buttonLabel: "Review setlist matches…",
      onClick: () => runTool(reviewSetlistMatches),
    }));
  }

  const unresolved = extractUnresolvedSetlistEntries(crateJson);
  if (unresolved.length) {
    list.appendChild(checkItem({
      text: `${plural(unresolved.length, "setlist entry", "setlist entries")} didn't match any song — check the spelling in the setlist or the song's {title:}.`,
      detail: unresolved.map((u) => `“${u.rawHeading}” in ${u.setlistPath}${u.setName ? ` (${u.setName})` : ""}`),
    }));
  }

  let stHits = [];
  try { stHits = await findStDirectiveHits(dirHandle); }
  catch (e) { log(`Could not check for {st:} credits: ${e.message}`, "warn"); }
  if (stHits.length) {
    list.appendChild(checkItem({
      text: `${plural(stHits.length, "old {st:} credit")} found — older charts used {st:} for the artist or composer.`,
      buttonLabel: "Fix credits…",
      onClick: () => runTool(fixStDirectives),
    }));
  }

  show($("checks-heading"), list.children.length > 0);
}

// Runs one of the review tools. They all patch the crate and songbook on
// disk themselves; if one also rewrote song files, the songbook is made
// again so the crate's copy of those songs catches up.
async function runTool(tool) {
  const outcome = await tool(toolContext());
  const changed = outcome === true || outcome?.changed;
  const wroteSongFiles = tool === fixStDirectives ? outcome === true : outcome?.wroteSongFiles;
  if (wroteSongFiles) {
    await makeSongbook();
  } else if (changed) {
    crateJson = await readJsonFromFolder(dirHandle, CRATE_FILE);
    await showResult({ fresh: true });
  }
}

async function openSongbook() {
  // Opened before any await so the browser still treats it as a response to
  // the click rather than a popup.
  const win = window.open("", "_blank");
  try {
    const file = await (await dirHandle.getFileHandle(currentSongbookFile())).getFile();
    const url = URL.createObjectURL(new Blob([await file.text()], { type: "text/html" }));
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    if (win) win.close();
    log(`Could not open ${currentSongbookFile()}: ${e.message}`, "err");
  }
}

/* ---------- start ---------- */

async function start() {
  if (!("showDirectoryPicker" in window)) {
    show($("unsupported"));
    show($("step-folder"), false);
    return;
  }
  $("pick-folder").addEventListener("click", () => whileBusy(pickFolder));
  $("book-form").addEventListener("submit", (event) => { event.preventDefault(); whileBusy(makeSongbook); });
  $("open-songbook").addEventListener("click", openSongbook);

  const last = await loadLastFolder();
  if (last) {
    const reopen = $("reopen-folder");
    reopen.textContent = `Reopen “${last.name}”`;
    reopen.addEventListener("click", () => whileBusy(() => openFolder(last)));
    show(reopen);
  }
}

start();
