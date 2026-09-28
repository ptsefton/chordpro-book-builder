// A minimal modal on top of <dialog>. The review tools (src/songbook/
// *_action.js) build their own body content; this only supplies the shell.
//
// openModal({ title, modalClassName, onDismiss, render(body, close) })
// resolves with whatever value the tool passes to close(value). Dismissing
// (the × button, Escape, or a click on the backdrop) resolves with
// onDismiss()'s return value, or undefined if there is none.
export function openModal({ title, modalClassName = "", onDismiss, render }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = `modal ${modalClassName}`.trim();

    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const header = document.createElement("div");
    header.className = "modal-header";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "modal-close";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "×";
    header.append(heading, closeButton);

    const body = document.createElement("div");
    body.className = "modal-body";
    panel.append(header, body);
    dialog.appendChild(panel);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const dismiss = () => close(onDismiss ? onDismiss() : undefined);

    closeButton.addEventListener("click", dismiss);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
    // The panel fills the dialog, so a click whose target is the dialog
    // itself landed on the backdrop.
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(); });

    render(body, close);
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
