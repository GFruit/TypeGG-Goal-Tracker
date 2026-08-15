// Toolbar popup for the Goal Tracker extension.
// It owns a single boolean in chrome.storage.local, "gtHideGoals".
// The content script watches the same key and shows or hides every widget
// to match, so flipping this toggle updates the page live.

const HIDE_KEY = "gtHideGoals";

const toggle = document.getElementById("show-goals");
const statusEl = document.getElementById("status");

// "Show goals" is the checked state, so hidden is the inverse.
function render(hidden) {
  toggle.checked = !hidden;
  statusEl.textContent = hidden
    ? "Goals are hidden on the page."
    : "Goals are showing on the page.";
}

// Reflect the stored value when the popup opens.
chrome.storage.local.get(HIDE_KEY, (res) => {
  render(!!(res && res[HIDE_KEY]));
});

// Persist changes; the content script reacts via storage.onChanged.
toggle.addEventListener("change", () => {
  const hidden = !toggle.checked;
  chrome.storage.local.set({ [HIDE_KEY]: hidden }, () => {
    render(hidden);
  });
});