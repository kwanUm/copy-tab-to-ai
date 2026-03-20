// Popup script for Copy Tab to AI

const btnSummarize = document.getElementById("btn-summarize");
const inputQuestion = document.getElementById("input-question");
const btnSend = document.getElementById("btn-send");
const btnSave = document.getElementById("btn-save");
const savedPromptsEl = document.getElementById("saved-prompts");
const promptsSection = document.getElementById("prompts-section");
const noPromptsEl = document.getElementById("no-prompts");

// Trigger extraction with a prompt suffix appended to the pasted text
async function triggerExtraction(promptSuffix) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  await chrome.runtime.sendMessage({
    type: "EXTRACT_AND_SEND",
    tabId: tab.id,
    tabUrl: tab.url,
    promptSuffix,
  });

  window.close();
}

// Saved prompts management
async function loadPrompts() {
  const { savedPrompts = [] } = await chrome.storage.sync.get("savedPrompts");
  return savedPrompts;
}

async function savePrompt(text) {
  const prompts = await loadPrompts();
  if (prompts.includes(text)) return;
  prompts.push(text);
  await chrome.storage.sync.set({ savedPrompts: prompts });
  renderPrompts(prompts);
}

async function deletePrompt(index) {
  const prompts = await loadPrompts();
  prompts.splice(index, 1);
  await chrome.storage.sync.set({ savedPrompts: prompts });
  renderPrompts(prompts);
}

function renderPrompts(prompts) {
  savedPromptsEl.innerHTML = "";

  if (prompts.length === 0) {
    promptsSection.style.display = "none";
    noPromptsEl.style.display = "";
    return;
  }

  promptsSection.style.display = "";
  noPromptsEl.style.display = "none";

  prompts.forEach((text, i) => {
    const item = document.createElement("div");
    item.className = "prompt-item";

    const span = document.createElement("span");
    span.className = "prompt-text";
    span.textContent = text;
    span.addEventListener("click", () => {
      triggerExtraction("\n\n------\n\n" + text);
    });

    const del = document.createElement("button");
    del.className = "prompt-delete";
    del.textContent = "\u00d7";
    del.title = "Delete prompt";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePrompt(i);
    });

    item.appendChild(span);
    item.appendChild(del);
    savedPromptsEl.appendChild(item);
  });
}

// Event handlers
btnSummarize.addEventListener("click", () => {
  triggerExtraction("\n\n------\n\nSummarize the main points of this page.");
});

btnSend.addEventListener("click", () => {
  const q = inputQuestion.value.trim();
  if (q) triggerExtraction("\n\n------\n\n" + q);
});

inputQuestion.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = inputQuestion.value.trim();
    if (q) triggerExtraction("\n\n------\n\n" + q);
  }
});

btnSave.addEventListener("click", () => {
  const q = inputQuestion.value.trim();
  if (q) {
    savePrompt(q);
    inputQuestion.value = "";
  }
});

// Init
loadPrompts().then(renderPrompts);
inputQuestion.focus();
