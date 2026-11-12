// Copy buttons: any element with data-copy="text" copies that text and shows "Copied".

export function initCopy() {
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-copy]");
    if (!button) return;
    const label = button.querySelector(".lbl");
    const code = button.querySelector("code") || button.parentElement.querySelector("code");
    const resetAfter = (ms) => {
      clearTimeout(button._reset);
      button._reset = setTimeout(() => {
        label.textContent = "Copy";
        delete button.dataset.state;
      }, ms);
    };
    /* no clipboard access (old browser, or a page in an iframe): select the command so one key press copies it */
    const selectInstead = () => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = /Mac|iP/.test(navigator.platform) ? "Press ⌘C" : "Press Ctrl+C";
      delete button.dataset.state;
      resetAfter(2600);
    };
    try {
      navigator.clipboard.writeText(button.dataset.copy).then(() => {
        label.textContent = "Copied";
        button.dataset.state = "ok";
        resetAfter(1800);
      }, selectInstead);
    } catch {
      selectInstead();
    }
  });
}
