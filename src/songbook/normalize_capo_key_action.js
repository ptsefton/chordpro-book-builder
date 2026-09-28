// "Normalize capos and keys…" (SPEC.md §18) — same shape as
// key_review_action.js's "Review guessed keys…": runs against the crate
// already on disk, independently of a build.
//
// Detects songs where the chart's own chord shapes don't match the charted
// `{key:}` a human typed, but DO match that key transposed down by the
// song's own `{capo:}` — this tool's own convention (docs/chordpro-format.md)
// is that `{key:}` is the charted/shape key and capo is independent of it,
// but a song built the chordpro.org way (key = the key it sounds in, capo
// separate) looks, from here, exactly like a mistake in that convention —
// chordpro_crate.js's own detectCapoKeyMismatch (SPEC.md §18) is what tells
// the two apart.

import JSZip from "jszip";
import { verifyPermission, readJsonFromFolder, getFileHandleAtPath, writeFileAtPath } from "./fs_helpers.js";
import { setDirectiveValue, extractCapoKeyMismatches } from "./chordpro_crate.js";
import { CRATE_FILE, writeOutputs } from "./songbook_build.js";

const BACKUP_DIR = ".chordpro-normalize-backups";

// This feature's own tile styling — injected once into document.head, same
// convention key_review_action.js's own ensureStylesInjected follows.
const STYLE_ELEMENT_ID = "chordpro-normalize-styles";
function ensureStylesInjected() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    .cnk-tile { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: var(--panel-2); }
    .cnk-tile:last-child { margin-bottom: 0; }
    .cnk-tile-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .cnk-tile-title { font-weight: 700; font-size: 14px; }
    .cnk-tile-chords { color: var(--muted); font-size: 12px; font-family: var(--mono); margin-bottom: 6px; }
    .cnk-tile-fix { font-size: 13px; }
    .cnk-write-back { display: flex; align-items: baseline; gap: 6px; margin: 14px 0 0; }
  `;
  document.head.appendChild(style);
}

function renderTiles(body, items) {
  const checkboxes = new Map();
  items.forEach((item) => {
    const tile = document.createElement("div");
    tile.className = "cnk-tile";

    const head = document.createElement("div");
    head.className = "cnk-tile-head";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true; // detected mismatches default to checked (fix applied unless unticked)
    checkboxes.set(item.id, checkbox);
    head.appendChild(checkbox);
    const title = document.createElement("span");
    title.className = "cnk-tile-title";
    title.textContent = item.title;
    head.appendChild(title);
    tile.appendChild(head);

    if (item.chordsUsed.length) {
      const chords = document.createElement("div");
      chords.className = "cnk-tile-chords";
      chords.textContent = `Chords: ${item.chordsUsed.join(", ")}`;
      tile.appendChild(chords);
    }

    const fix = document.createElement("div");
    fix.className = "cnk-tile-fix";
    fix.textContent = `Currently key: ${item.currentKey}, capo: ${item.capo} → ` +
      `key: ${item.suggestedKey}, transpose: ${item.suggestedTranspose}, capo: ${item.capo} (unchanged)`;
    tile.appendChild(fix);

    body.appendChild(tile);
  });
  return checkboxes;
}

// item.id -> true/false, whether the checkbox is still ticked, for every
// item still present.
function collectSelections(checkboxes) {
  const selections = {};
  for (const [id, checkbox] of checkboxes) selections[id] = checkbox.checked;
  return selections;
}

function openNormalizeModal(openModal, items) {
  ensureStylesInjected();
  let checkboxes;
  let writeBackCheckbox;
  return openModal({
    title: "Normalize capos and keys",
    modalClassName: "mapping-modal",
    onDismiss: () => null,
    render(body, close) {
      const intro = document.createElement("p");
      intro.className = "hint";
      intro.style.margin = "-8px 0 0";
      intro.textContent = "Songs where the chart's own chords suggest the key was written as it " +
        "sounds (with the capo already applied) rather than as charted. Untick any you'd rather " +
        "leave alone, then Save.";
      body.appendChild(intro);

      const summary = document.createElement("div");
      summary.className = "hint";
      summary.textContent = `${items.length} song${items.length === 1 ? "" : "s"} found.`;
      body.appendChild(summary);

      const tilesEl = document.createElement("div");
      tilesEl.className = "mapping-body";
      checkboxes = renderTiles(tilesEl, items);
      body.appendChild(tilesEl);

      const writeBackRow = document.createElement("label");
      writeBackRow.className = "cnk-write-back";
      writeBackCheckbox = document.createElement("input");
      writeBackCheckbox.type = "checkbox";
      writeBackRow.appendChild(writeBackCheckbox);
      writeBackRow.appendChild(document.createTextNode(
        "Also rewrite {key:} and {transpose:} in the song files (backs up originals first)"
      ));
      body.appendChild(writeBackRow);

      const actions = document.createElement("div");
      actions.className = "actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button"; saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => close({
        selections: collectSelections(checkboxes),
        writeBack: writeBackCheckbox.checked,
      }));
      actions.appendChild(saveBtn);
      body.appendChild(actions);
    },
  });
}

// Backs up, then rewrites, every file in `entries` ({id, suggestedKey,
// suggestedTranspose}) — a separate backup folder from key_review_action.js's
// own (SPEC.md §17) and fix_st_directive_action.js's own (§15), so all
// three tools' backups are never mixed together in one listing. Re-reads
// each file fresh off disk rather than trusting the crate's own (possibly
// stale) `text`, same reasoning as those tools.
async function writeNormalizedFiles(dirHandle, entries) {
  const zip = new JSZip();
  let filesChanged = 0;
  for (const { id, suggestedKey, suggestedTranspose } of entries) {
    const fh = await getFileHandleAtPath(dirHandle, id);
    const original = await (await fh.getFile()).text();
    zip.file(id, original);
    const withKey = setDirectiveValue(original, ["key"], suggestedKey);
    const rewritten = setDirectiveValue(withKey, ["transpose", "tr"], suggestedTranspose);
    const w = await fh.createWritable();
    await w.write(rewritten);
    await w.close();
    filesChanged += 1;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${BACKUP_DIR}/${timestamp}.zip`;
  await writeFileAtPath(dirHandle, backupPath, await zip.generateAsync({ type: "arraybuffer" }));
  return { filesChanged, backupPath };
}

// Resolves to { changed, wroteSongFiles }, same as reviewKeyGuesses.
export async function normalizeCapoKeys({ dirHandle, log, openModal }) {
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

  const mismatches = extractCapoKeyMismatches(crateJson);
  if (!mismatches.length) {
    log("Normalize capos and keys: no likely mismatches found.", "info");
    return;
  }

  const picks = await openNormalizeModal(openModal, mismatches);
  if (!picks) {
    log("Normalize capos and keys: cancelled, nothing changed.", "info");
    return;
  }

  const byId = new Map(crateJson["@graph"].map((entity) => [entity["@id"], entity]));
  const toApply = mismatches.filter((item) => picks.selections[item.id]);
  if (!toApply.length) {
    log("Normalize capos and keys: no changes selected.", "info");
    return;
  }

  for (const item of toApply) {
    const entity = byId.get(item.id);
    if (!entity) continue;
    entity.musicalKey = item.suggestedKey;
    entity["custom:transpose"] = item.suggestedTranspose;
  }

  try {
    await writeOutputs(dirHandle, crateJson, log);
    let message = `Normalize capos and keys: fixed ${toApply.length} song${toApply.length === 1 ? "" : "s"}.`;
    let wroteSongFiles = false;
    if (picks.writeBack) {
      const { filesChanged, backupPath } = await writeNormalizedFiles(dirHandle, toApply);
      message += ` Wrote {key:}/{transpose:} into ${filesChanged} file(s) (backup: ${backupPath}).`;
      wroteSongFiles = filesChanged > 0;
    }
    log(message, "ok");
    return { changed: true, wroteSongFiles };
  } catch (e) {
    log("Could not save normalize changes: " + (e && e.message ? e.message : e), "err");
    return { changed: false, wroteSongFiles: false };
  }
}
