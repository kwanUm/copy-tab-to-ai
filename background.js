// Background service worker for Copy Tab to AI

const LOG = (...args) => console.log("[Copy Tab to AI BG]", ...args);
const ERR = (...args) => console.error("[Copy Tab to AI BG]", ...args);

function isPdfUrl(url) {
  if (!url) return false;
  return /\.pdf(\?|#|$)/i.test(url) || /\/pdf\//i.test(url);
}

// Inject extraction scripts into a tab
async function handleExtraction(tabId, tabUrl) {
  let script;
  if (isPdfUrl(tabUrl)) {
    script = "pdf-extract.js";
  } else {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const embed = document.querySelector('embed[type="application/pdf"]');
        const obj = document.querySelector('object[type="application/pdf"]');
        return !!(embed || obj);
      },
    });
    script = result?.result ? "pdf-extract.js" : "content-extract.js";
  }
  LOG(`Injecting ${script} for ${tabUrl}`);
  const files = script === "content-extract.js"
    ? ["readability.js", "content-extract.js"]
    : [script];
  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_AND_SEND") {
    const { tabId, tabUrl, promptSuffix, targetUrl } = message;
    LOG("EXTRACT_AND_SEND:", { tabId, tabUrl: tabUrl?.substring(0, 80), targetUrl, promptSuffix: promptSuffix?.substring(0, 60) });
    // Store prompt suffix and target URL so they get merged into pageData later
    chrome.storage.local.set({ promptSuffix: promptSuffix || "", targetUrl: targetUrl || "https://claude.ai/new" }).then(() =>
    handleExtraction(tabId, tabUrl)).then(
      () => sendResponse({ ok: true }),
      (err) => { ERR("Extraction failed:", err); sendResponse({ ok: false, error: err.message }); }
    );
    return true;
  }

  if (message.type === "PAGE_DATA_EXTRACTED") {
    LOG("Received PAGE_DATA_EXTRACTED:", {
      url: message.data.url,
      contentItems: message.data.content?.length,
      imageItems: message.data.imageItems?.length,
    });
    handlePageData(message.data).then(
      () => { LOG("handlePageData complete"); sendResponse({ ok: true }); },
      (err) => { ERR("handlePageData error:", err); sendResponse({ ok: false, error: err.message }); }
    );
    return true;
  }

  if (message.type === "FETCH_IMAGE") {
    LOG("Fetching CORS image:", message.url?.substring(0, 100));
    fetchImageAsDataUrl(message.url).then(
      (dataUrl) => {
        LOG("CORS image fetch result:", dataUrl ? `${Math.round(dataUrl.length / 1024)}KB` : "null");
        sendResponse({ dataUrl });
      },
      () => { LOG("CORS image fetch failed"); sendResponse({ dataUrl: null }); }
    );
    return true;
  }

  if (message.type === "OPEN_CLAUDE_AND_PASTE") {
    chrome.storage.local.get("targetUrl").then(({ targetUrl }) => {
      openTargetAndPaste(targetUrl || "https://claude.ai/new").then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: err.message })
      );
    });
    return true;
  }

  if (message.type === "FETCH_PDF") {
    fetch(message.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        // Convert to base64 to pass through messaging
        const bytes = new Uint8Array(buf);
        let binary = "";
        // Process in chunks to avoid call stack overflow
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        sendResponse({ data: btoa(binary) });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GET_PAGE_DATA") {
    chrome.storage.local.get("pageData").then(
      ({ pageData }) => sendResponse({ pageData }),
      () => sendResponse({ pageData: null })
    );
    return true;
  }
});

// Fetch an image in the background (no CORS restrictions with host_permissions)
async function fetchImageAsDataUrl(url) {
  const shortUrl = url.substring(0, 120);
  try {
    LOG(`Fetching image: ${shortUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      LOG(`Image fetch failed: HTTP ${response.status} for ${shortUrl}`);
      return null;
    }
    const blob = await response.blob();
    LOG(`Image fetched: type=${blob.type}, size=${Math.round(blob.size / 1024)}KB for ${shortUrl}`);
    if (!blob.type.startsWith("image/")) {
      LOG(`Skipping non-image blob type: ${blob.type}`);
      return null;
    }

    // Skip very large images (>5MB)
    if (blob.size > 5 * 1024 * 1024) {
      LOG(`Skipping oversized image: ${Math.round(blob.size / 1024)}KB`);
      return null;
    }

    // Convert blob to base64
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const dataUrl = `data:${blob.type};base64,${btoa(binary)}`;
    LOG(`Image converted: ${Math.round(dataUrl.length / 1024)}KB dataUrl for ${shortUrl}`);
    return dataUrl;
  } catch (err) {
    ERR(`Image fetch error for ${shortUrl}:`, err.message || err);
    return null;
  }
}

async function handlePageData(pageData) {
  // Fetch images that failed CORS in content script via background
  const imagePromises = [];
  const corsImageCount = [...(pageData.content || []), ...(pageData.imageItems || [])].filter(i => i.type === "image_url").length;
  LOG(`Resolving ${corsImageCount} CORS-failed images via background fetch...`);

  const content = pageData.content;
  for (let i = 0; i < content.length; i++) {
    if (content[i].type === "image_url") {
      const idx = i;
      const url = content[i].url;
      imagePromises.push(
        fetchImageAsDataUrl(url).then((dataUrl) => {
          if (dataUrl) {
            content[idx] = { ...content[idx], type: "image", dataUrl };
          } else {
            content[idx] = null;
          }
        })
      );
    }
  }

  // Resolve image_url items in imageItems (all images for uploading)
  const imageItems = pageData.imageItems || [];
  for (let i = 0; i < imageItems.length; i++) {
    if (imageItems[i].type === "image_url") {
      const idx = i;
      const url = imageItems[i].url;
      LOG(`Fetching imageItem[${idx}]: ${url.substring(0, 100)}`);
      imagePromises.push(
        fetchImageAsDataUrl(url).then((dataUrl) => {
          if (dataUrl) {
            LOG(`imageItem[${idx}] resolved: ${Math.round(dataUrl.length / 1024)}KB`);
            imageItems[idx] = { ...imageItems[idx], type: "image", dataUrl };
          } else {
            LOG(`imageItem[${idx}] failed: no data returned`);
            imageItems[idx] = null;
          }
        })
      );
    }
  }

  // Timeout all image fetches after 15s total
  const timedOut = await Promise.race([
    Promise.all(imagePromises).then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 15000)),
  ]);
  if (timedOut) LOG("WARNING: Image fetch timed out after 15s, proceeding with what we have");

  pageData.content = content.filter(Boolean);
  pageData.imageItems = imageItems.filter(Boolean);
  LOG(`After CORS resolution: ${pageData.imageItems.length} images with data`);

  // Merge prompt suffix from popup
  const { promptSuffix = "", targetUrl = "https://claude.ai/new" } = await chrome.storage.local.get(["promptSuffix", "targetUrl"]);
  if (promptSuffix) {
    pageData.promptSuffix = promptSuffix;
    LOG("Attached promptSuffix:", promptSuffix.substring(0, 60));
  }

  // Store the data
  await chrome.storage.local.set({ pageData });
  LOG("pageData stored to chrome.storage.local");

  // Open target AI and inject paste
  return openTargetAndPaste(targetUrl);
}

async function openTargetAndPaste(targetUrl) {
  LOG("Opening target:", targetUrl);
  const tab = await chrome.tabs.create({ url: targetUrl });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn("Target tab load timed out, attempting injection anyway");
      injectPasteScript(tab.id).then(resolve);
    }, 30000);

    function listener(tabId, changeInfo) {
      if (tabId === tab.id && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => injectPasteScript(tab.id).then(resolve), 3000);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectPasteScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-paste.js"],
    });
  } catch (err) {
    console.error("Failed to inject paste script:", err);
  }
}
