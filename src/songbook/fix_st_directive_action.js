// "Fix old {st:} credits…" (SPEC.md §15) — a folder-scoped cleanup, not
// part of a build: scans the song files for {st:} used as a performer or
// composer credit, lets a human choose what each becomes, and rewrites the
// files after backing them up. The app rebuilds the songbook afterwards so
// the new credits show up. The row list uses the app's generic
// .mapping-head/.mapping-row/.col-source classes (app/app.css).

import { verifyPermission } from "./fs_helpers.js";
import { findStDirectiveHits, applyStDirectiveFixes } from "./fix_st_directive_ui.js";

export { findStDirectiveHits };

function renderRows(container, hits) {
  const head = document.createElement("div");
  head.className = "mapping-head";
  head.innerHTML = "<span>File</span><span>{st:} value</span><span>Becomes</span>";
  container.appendChild(head);

  hits.forEach((hit) => {
    const row = document.createElement("div");
    row.className = "mapping-row";
    row.dataset.number = String(hit.number);

    const src = document.createElement("div");
    src.className = "col-source";
    src.textContent = `${hit.relativePath}:${hit.lineNumber}`;

    const valueEl = document.createElement("div");
    valueEl.className = "col-source";
    valueEl.textContent = hit.value;

    const select = document.createElement("select");
    select.className = "fix-st-choice";
    [
      ["artist", "Artist"],
      ["composer", "Composer"],
      ["both", "Both (artist + composer)"],
      ["skip", "Leave as {st:}"],
    ].forEach(([choiceValue, text]) => {
      const opt = document.createElement("option");
      opt.value = choiceValue; opt.textContent = text;
      select.appendChild(opt);
    });
    select.value = "artist";

    row.append(src, valueEl, select);
    container.appendChild(row);
  });
}

// Resolves to true if any song file was rewritten.
export async function fixStDirectives({ dirHandle, log, openModal }) {
  if (!(await verifyPermission(dirHandle, true))) {
    log("Permission to read/write the folder was denied.", "err");
    return false;
  }
  let hits;
  try {
    hits = await findStDirectiveHits(dirHandle);
  } catch (e) {
    log("Could not scan the folder for {st:} directives: " + (e && e.message ? e.message : e), "err");
    return false;
  }
  if (!hits.length) {
    log(`No {st:} directives found in ${dirHandle.name}.`, "info");
    return false;
  }

  let changed = false;
  await openModal({
    title: "Fix old {st:} credits",
    modalClassName: "mapping-modal",
    render(body, close) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.margin = "-8px 0 0";
      hint.innerHTML = "Charts from before this app split artist/subtitle sometimes use <code>{st:}</code> for a " +
        "performer or composer credit. Choose what each occurrence should become, then apply — the originals are " +
        "backed up to a zip first.";
      body.appendChild(hint);

      const summary = document.createElement("div");
      summary.className = "hint";
      summary.textContent = `${hits.length} occurrence(s) across ${new Set(hits.map((h) => h.relativePath)).size} file(s).`;
      body.appendChild(summary);

      const rows = document.createElement("div");
      rows.className = "mapping-body";
      renderRows(rows, hits);
      body.appendChild(rows);

      const actions = document.createElement("div");
      actions.className = "actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => close());
      const applyBtn = document.createElement("button");
      applyBtn.type = "button"; applyBtn.textContent = "Apply";
      applyBtn.addEventListener("click", async () => {
        const choicesByNumber = {};
        rows.querySelectorAll(".mapping-row").forEach((row) => {
          choicesByNumber[Number(row.dataset.number)] = row.querySelector(".fix-st-choice").value;
        });
        try {
          const result = await applyStDirectiveFixes(dirHandle, hits, choicesByNumber);
          changed = result.filesChanged > 0;
          log(
            `Fixed {st:} credits: rewrote ${result.filesChanged} file(s), ${result.occurrences} occurrence(s). ` +
              `Backup: ${result.backupPath}`,
            "ok",
          );
        } catch (e) {
          log("Failed to apply {st:} fixes: " + (e && e.message ? e.message : e), "err");
        }
        close();
      });
      actions.append(cancelBtn, applyBtn);
      body.appendChild(actions);
    },
  });
  return changed;
}
