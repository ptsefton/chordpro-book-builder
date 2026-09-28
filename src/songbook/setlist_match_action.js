// Resolving ambiguous setlist matches (SPEC.md §16): a pre-build soft gate
// (resolveSetlistMatches, which the app awaits before every build) plus
// reviewSetlistMatches, the "Review setlist matches…" button for revisiting
// a match after the fact. The app hands in openModal (app/modal.js); this
// file builds the modal's body itself.

import { verifyPermission, readJsonFromFolder } from "./fs_helpers.js";
import { extractReviewableSetlistMatches, findAmbiguousSetlistMatches, extractPersistedSetlistMatches } from "./chordpro_crate.js";
import { CRATE_FILE, writeOutputs } from "./songbook_build.js";

// This feature's own tile styling — injected once into document.head, so
// app/app.css never has to know these class names exist.
const STYLE_ELEMENT_ID = "chordpro-setlist-match-styles";
function ensureStylesInjected() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    .csm-match-tile { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: var(--panel-2); }
    .csm-match-tile:last-child { margin-bottom: 0; }
    .csm-match-tile-title { font-weight: 700; font-size: 14px; }
    .csm-match-tile-context { color: var(--muted); font-size: 11.5px; margin: 2px 0 10px; }
    .csm-match-candidate-list { display: flex; flex-direction: column; gap: 6px; }
    .csm-match-candidate { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 6px 8px; border-radius: 8px; border: 1px solid transparent; }
    .csm-match-candidate:hover { border-color: var(--border); }
    .csm-match-candidate input[type="radio"] { margin-top: 3px; flex-shrink: 0; }
    .csm-match-candidate-title { font-size: 13px; display: block; }
    .csm-match-candidate-path { display: block; font-style: italic; color: var(--muted); font-size: 11px; font-family: var(--mono); overflow-wrap: anywhere; }
    /* Only shown in the post-build review (renderTiles' own showRecommended
       option) — rankCandidatesByPath's own pick, independent of which
       candidate is actually selected, so a reviewer can spot the two
       disagreeing at a glance. */
    .csm-match-candidate-badge {
      display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
      background: var(--panel-2); border: 1px solid var(--border); color: var(--muted);
      font-size: 10px; font-style: normal; text-transform: uppercase; letter-spacing: 0.04em;
      vertical-align: middle;
    }
  `;
  document.head.appendChild(style);
}

// Shared by the pre-build soft gate (resolveSetlistMatches, below) and the
// post-build review (reviewSetlistMatches) — the tiles themselves are
// identical either way; only which candidate starts selected, and whether
// a "closest" badge is worth showing at all, differ.
function renderTiles(body, items, { showRecommended = false } = {}) {
  items.forEach((item, tileIndex) => {
    const tile = document.createElement("div");
    tile.className = "csm-match-tile";
    tile.dataset.key = item.key;

    const title = document.createElement("div");
    title.className = "csm-match-tile-title";
    title.textContent = item.rawHeading;
    tile.appendChild(title);

    const context = document.createElement("div");
    context.className = "csm-match-tile-context";
    context.textContent = item.setName ? `${item.setlistPath} — ${item.setName}` : item.setlistPath;
    tile.appendChild(context);

    const selectedId = item.currentId ?? item.candidates[0]?.id;
    const list = document.createElement("div");
    list.className = "csm-match-candidate-list";
    item.candidates.forEach((candidate) => {
      const label = document.createElement("label");
      label.className = "csm-match-candidate";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `setlist-match-${tileIndex}`;
      radio.value = candidate.id;
      radio.checked = candidate.id === selectedId;

      const text = document.createElement("span");
      const titleSpan = document.createElement("span");
      titleSpan.className = "csm-match-candidate-title";
      titleSpan.textContent = candidate.title;
      if (showRecommended && candidate.id === item.recommendedId) {
        const badge = document.createElement("span");
        badge.className = "csm-match-candidate-badge";
        badge.textContent = "closest";
        titleSpan.appendChild(badge);
      }
      const pathSpan = document.createElement("span");
      pathSpan.className = "csm-match-candidate-path";
      pathSpan.textContent = candidate.id;
      text.append(titleSpan, pathSpan);

      label.append(radio, text);
      list.appendChild(label);
    });
    tile.appendChild(list);
    body.appendChild(tile);
  });
}

function collectPicks(tilesEl) {
  const picks = {};
  tilesEl.querySelectorAll(".csm-match-tile").forEach((tile) => {
    const checked = tile.querySelector("input[type=radio]:checked");
    if (checked) picks[tile.dataset.key] = checked.value;
  });
  return picks;
}

// items -> picks (never null: SPEC.md §16's own soft gate — even every tile
// sitting on its own default is always fine to build with, so there's no
// real cancel outcome here; the × icon and a backdrop click both just apply
// whatever's currently selected, via onDismiss).
function openPreBuildModal(openModal, items) {
  ensureStylesInjected();
  let tilesEl;
  return openModal({
    title: "Review setlist matches",
    modalClassName: "mapping-modal",
    onDismiss: () => collectPicks(tilesEl),
    render(body, close) {
      const intro = document.createElement("p");
      intro.className = "hint";
      intro.style.margin = "-8px 0 0";
      intro.textContent = "Some setlist entries matched more than one song. The one closest to the setlist file " +
        "itself is picked for you below — change any of them, or just build with these choices as they are.";
      body.appendChild(intro);

      const summary = document.createElement("div");
      summary.className = "hint";
      summary.textContent = `${items.length} setlist entr${items.length === 1 ? "y needs" : "ies need"} a match reviewed.`;
      body.appendChild(summary);

      tilesEl = document.createElement("div");
      tilesEl.className = "mapping-body";
      renderTiles(tilesEl, items);
      body.appendChild(tilesEl);

      const actions = document.createElement("div");
      actions.className = "actions";
      const buildBtn = document.createElement("button");
      buildBtn.type = "button"; buildBtn.textContent = "Build";
      buildBtn.addEventListener("click", () => close(collectPicks(tilesEl)));
      actions.appendChild(buildBtn);
      body.appendChild(actions);
    },
  });
}

// The post-build counterpart (SPEC.md §16, "reviewing already-resolved
// matches") — same tiles, but every candidate actually on record
// (item.currentId) starts selected instead of the closest one, which is
// marked with a badge instead (showRecommended) so a reviewer can tell at a
// glance whether the two agree. Resolves to null if dismissed without
// clicking "Save" — a genuine cancel, unlike the pre-build modal above.
function openReviewModal(openModal, items) {
  ensureStylesInjected();
  return openModal({
    title: "Review setlist matches",
    modalClassName: "mapping-modal",
    onDismiss: () => null,
    render(body, close) {
      const intro = document.createElement("p");
      intro.className = "hint";
      intro.style.margin = "-8px 0 0";
      intro.textContent = "Every setlist entry that ever matched more than one song, including ones already " +
        "resolved — the “closest” badge marks the song path-proximity would pick; your current choice, " +
        "right or not, starts selected.";
      body.appendChild(intro);

      const summary = document.createElement("div");
      summary.className = "hint";
      summary.textContent = `${items.length} setlist match${items.length === 1 ? "" : "es"} on record — change any of them, then Save.`;
      body.appendChild(summary);

      const tilesEl = document.createElement("div");
      tilesEl.className = "mapping-body";
      renderTiles(tilesEl, items, { showRecommended: true });
      body.appendChild(tilesEl);

      const actions = document.createElement("div");
      actions.className = "actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button"; saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => close(collectPicks(tilesEl)));
      actions.appendChild(saveBtn);
      body.appendChild(actions);
    },
  });
}

// The "Review setlist matches…" button — reads whatever's on disk right
// now, lets a human revisit any entry that was *ever* ambiguous
// (extractReviewableSetlistMatches, unlike findAmbiguousSetlistMatches,
// doesn't filter by "already resolved" at all), and patches + rewrites
// ro-crate-metadata.json and the songbook directly for whatever actually
// changed — no folder re-scan, no rebuild. Resolves to true if anything
// was rewritten.
export async function reviewSetlistMatches({ dirHandle, log, openModal }) {
  if (!(await verifyPermission(dirHandle, true))) {
    log("Permission to read/write the folder was denied.", "err");
    return;
  }

  let crateJson;
  try {
    crateJson = await readJsonFromFolder(dirHandle, CRATE_FILE);
  } catch (e) {
    log("Could not read " + CRATE_FILE + ": " + (e && e.message ? e.message : e), "err");
    return;
  }
  if (!crateJson) {
    log(CRATE_FILE + " not found — build a songbook first.", "info");
    return;
  }

  const reviewable = extractReviewableSetlistMatches(crateJson);
  if (!reviewable.length) {
    log("No setlist matches to review — no setlist entry in this crate was ever ambiguous.", "info");
    return;
  }

  const picks = await openReviewModal(openModal, reviewable);
  if (!picks) {
    log("Setlist matches: cancelled, nothing changed.", "info");
    return;
  }

  const byId = new Map(crateJson["@graph"].map((entity) => [entity["@id"], entity]));
  let changedCount = 0;
  for (const item of reviewable) {
    const chosen = picks[item.key];
    if (!chosen || chosen === item.currentId) continue;
    const entity = byId.get(item.entryId);
    if (!entity) continue;
    entity.specializationOf = { "@id": chosen };
    changedCount += 1;
  }

  if (!changedCount) {
    log("Setlist matches: no changes made.", "info");
    return;
  }

  try {
    await writeOutputs(dirHandle, crateJson, log);
    log(`Setlist matches: updated ${changedCount} entr${changedCount === 1 ? "y" : "ies"}.`, "ok");
    return true;
  } catch (e) {
    log("Could not save setlist match changes: " + (e && e.message ? e.message : e), "err");
    return false;
  }
}

// Runs before every build. Reads whatever crate already exists for choices
// a human has already made on an earlier build, reusing anything still
// valid; opens the review modal only for whatever's left. Always resolves
// to a usable overrides object (matchKey -> song @id) for
// buildSongbook's matchOverrides — SPEC.md §16's own soft gate, never a
// hard block on the build itself.
export async function resolveSetlistMatches(dirHandle, { log, openModal }) {

  let scan;
  try {
    scan = await findAmbiguousSetlistMatches(dirHandle);
  } catch (e) {
    log("Could not check setlist matches: " + (e && e.message ? e.message : e), "err");
    return {};
  }
  if (!scan.entries.length) return {};

  let priorCrateJson = null;
  try {
    priorCrateJson = await readJsonFromFolder(dirHandle, CRATE_FILE);
  } catch {
    priorCrateJson = null;
  }
  const persisted = priorCrateJson ? extractPersistedSetlistMatches(priorCrateJson) : {};
  // Every currently-harvested song, not just candidates for any one entry —
  // this is what tells "the file is genuinely gone" apart from "it exists
  // but doesn't match this entry any more" when a persisted choice turns
  // out not to be one of this entry's current candidates.
  const songIds = new Set(scan.songs.map((s) => s.id));

  const overrides = {};
  const needsReview = [];
  for (const item of scan.entries) {
    const persistedId = persisted[item.key];
    if (persistedId && item.candidates.some((c) => c.id === persistedId)) {
      overrides[item.key] = persistedId;
      continue;
    }
    if (persistedId && !songIds.has(persistedId)) {
      log(
        `Discarded a previously-resolved match for "${item.rawHeading}" in ${item.setlistPath} — ` +
          "the song it pointed to no longer exists; please re-resolve.",
        "muted",
      );
    }
    needsReview.push(item);
  }

  if (!needsReview.length) return overrides;

  log(
    `${needsReview.length} setlist entr${needsReview.length === 1 ? "y needs" : "ies need"} a match reviewed before building.`,
    "info",
  );
  const picks = await openPreBuildModal(openModal, needsReview);
  return { ...overrides, ...picks };
}
