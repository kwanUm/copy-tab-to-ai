// Popup script for Copy Tab to AI

const TARGETS = {
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/",
};

const btnSummarize = document.getElementById("btn-summarize");
const inputQuestion = document.getElementById("input-question");
const btnSend = document.getElementById("btn-send");
const btnSave = document.getElementById("btn-save");
const savedPromptsEl = document.getElementById("saved-prompts");
const promptsSection = document.getElementById("prompts-section");
const noPromptsEl = document.getElementById("no-prompts");
const customUrlRow = document.getElementById("custom-url-row");
const inputCustomUrl = document.getElementById("input-custom-url");
const targetBtns = document.querySelectorAll(".target-btn");

let currentTarget = "claude";

// --- Target AI selection ---

async function loadTarget() {
  const { aiTarget = "claude", customUrl = "" } = await chrome.storage.sync.get(["aiTarget", "customUrl"]);
  currentTarget = aiTarget;
  if (customUrl) inputCustomUrl.value = customUrl;
  updateTargetUI();
}

function updateTargetUI() {
  targetBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === currentTarget);
  });
  customUrlRow.style.display = currentTarget === "custom" ? "" : "none";
}

async function setTarget(target) {
  currentTarget = target;
  updateTargetUI();
  const save = { aiTarget: target };
  if (target === "custom") {
    save.customUrl = inputCustomUrl.value.trim();
  }
  await chrome.storage.sync.set(save);
}

function getTargetUrl() {
  if (currentTarget === "custom") {
    return inputCustomUrl.value.trim() || TARGETS.claude;
  }
  return TARGETS[currentTarget] || TARGETS.claude;
}

targetBtns.forEach((btn) => {
  btn.addEventListener("click", () => setTarget(btn.dataset.target));
});

inputCustomUrl.addEventListener("change", () => {
  chrome.storage.sync.set({ customUrl: inputCustomUrl.value.trim() });
});

// --- Extraction ---

async function triggerExtraction(promptSuffix) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  await chrome.runtime.sendMessage({
    type: "EXTRACT_AND_SEND",
    tabId: tab.id,
    tabUrl: tab.url,
    promptSuffix,
    targetUrl: getTargetUrl(),
  });

  window.close();
}

// --- Saved prompts ---

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

// --- Event handlers ---

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

// --- Init ---

loadTarget();
loadPrompts().then(renderPrompts);
inputQuestion.focus();
