// Content script: pastes extracted content into Claude.ai's editor
(async () => {
  "use strict";

  const LOG = (...args) => console.log("[Copy Tab to AI]", ...args);
  const ERR = (...args) => console.error("[Copy Tab to AI]", ...args);

  LOG("content-paste.js loaded");

  const { pageData } = await chrome.runtime.sendMessage({
    type: "GET_PAGE_DATA",
  });
  if (!pageData) {
    ERR("No page data found in storage");
    return;
  }

  LOG("pageData received:", {
    url: pageData.url,
    title: pageData.title,
    isPdf: pageData.isPdf,
    contentItems: pageData.content?.length,
    imageItems: pageData.imageItems?.length,
  });

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Wait for Claude.ai's editor to be ready
  async function waitForEditor(maxWaitMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // Claude.ai uses a contenteditable div with ProseMirror
      const candidates = document.querySelectorAll(
        '[contenteditable="true"]'
      );
      for (const el of candidates) {
        // Must be visible and not a tiny element
        if (el.offsetParent !== null && el.offsetHeight > 20) {
          return el;
        }
      }
      await sleep(300);
    }
    return null;
  }

  function dataUrlToFile(dataUrl, filename) {
    const [header, data] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], filename, { type: mime });
  }

  const MAX_IMAGES = 7;
  const MAX_IMAGE_DATA_URL_SIZE = 2 * 1024 * 1024; // 2MB per image data URL

  // Select the top N most important images and return the kept set of indices
  function selectTopImages(imageItems) {
    // Filter out images without data URLs (failed fetches) and oversized ones
    const valid = imageItems.filter((img) => {
      if (!img.dataUrl) {
        LOG(`Skipping image index=${img.index}: no dataUrl`);
        return false;
      }
      if (img.dataUrl.length > MAX_IMAGE_DATA_URL_SIZE) {
        LOG(`Skipping image index=${img.index}: dataUrl too large (${Math.round(img.dataUrl.length / 1024)}KB)`);
        return false;
      }
      return true;
    });

    if (valid.length <= MAX_IMAGES) {
      return { kept: valid, truncated: 0, keptIndices: new Set(valid.map((i) => i.index)) };
    }
    // Sort by score descending, pick top N
    const ranked = [...valid].sort((a, b) => (b.score || 0) - (a.score || 0));
    const kept = ranked.slice(0, MAX_IMAGES);
    const keptIndices = new Set(kept.map((i) => i.index));
    return { kept, truncated: valid.length - MAX_IMAGES, keptIndices };
  }

  function buildTextContent(pageData, keptIndices, truncatedCount) {
    let text = `Content from: ${pageData.title}\nURL: ${pageData.url}\n\n---\n\n`;

    for (const item of pageData.content) {
      if (item.type === "text") {
        let value = item.value;
        value = value.replace(/\s?\[img(\d+)\]\s?/g, (match, num) => {
          return keptIndices.has(parseInt(num)) ? match : " ";
        });
        value = value.replace(/ {2,}/g, " ").trim();
        if (value.length > 0) {
          text += value + "\n\n";
        }
      } else if (item.type === "image" || item.type === "image_url") {
        if (keptIndices.has(item.index)) {
          text += `[img${item.index}]\n\n`;
        }
      }
    }

    if (truncatedCount > 0) {
      text += `\n---\n(${truncatedCount} additional image${truncatedCount > 1 ? "s" : ""} from the page not included)\n`;
    }

    return text.trim();
  }

  // Paste images as files
  async function pasteImages(editor, images) {
    if (images.length === 0) return;

    const files = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      LOG(`Preparing image ${i + 1}/${images.length}: ${Math.round(img.dataUrl.length / 1024)}KB, score=${img.score}`);
      const ext = img.dataUrl.includes("image/png") ? "png" : "jpg";
      files.push(dataUrlToFile(img.dataUrl, `page-image-${i + 1}.${ext}`));
    }

    const method = await uploadFiles(files);
    LOG(`Images upload method: ${method}`);
  }

  // Try multiple methods to insert text into ProseMirror editor
  function insertText(editor, text) {
    editor.focus();

    // Move cursor to end
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // Method 1: execCommand (best ProseMirror compatibility)
    LOG("Trying text insertion method 1: execCommand");
    const success = document.execCommand("insertText", false, text);
    if (success && editor.textContent.length > 10) {
      LOG("Method 1 succeeded, editor length:", editor.textContent.length);
      return true;
    }
    LOG("Method 1 result:", { success, editorLength: editor.textContent.length });

    // Method 2: InputEvent with insertText
    LOG("Trying text insertion method 2: InputEvent");
    editor.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );

    if (editor.textContent.length > 10) {
      LOG("Method 2 succeeded, editor length:", editor.textContent.length);
      return true;
    }

    // Method 3: Clipboard paste with text
    LOG("Trying text insertion method 3: ClipboardEvent paste");
    const textDt = new DataTransfer();
    textDt.setData("text/plain", text);
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: textDt,
      })
    );

    const finalLength = editor.textContent.length;
    LOG("Method 3 done, editor length:", finalLength);
    return finalLength > 10;
  }

  // Status overlay with progress bar
  function showStatus(text, progress) {
    let el = document.getElementById("copy-tab-ai-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "copy-tab-ai-status";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "80px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "999999",
        background: "#1a1a2e",
        color: "white",
        padding: "10px 16px",
        borderRadius: "10px",
        fontSize: "13px",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        transition: "opacity 0.3s",
        minWidth: "200px",
      });

      const label = document.createElement("div");
      label.id = "copy-tab-ai-status-label";
      el.appendChild(label);

      const track = document.createElement("div");
      Object.assign(track.style, {
        marginTop: "8px",
        height: "4px",
        borderRadius: "2px",
        background: "rgba(255,255,255,0.15)",
        overflow: "hidden",
      });
      const bar = document.createElement("div");
      bar.id = "copy-tab-ai-status-bar";
      Object.assign(bar.style, {
        height: "100%",
        width: "0%",
        borderRadius: "2px",
        background: "#6c7cff",
        transition: "width 0.3s ease",
      });
      track.appendChild(bar);
      el.appendChild(track);

      document.body.appendChild(el);
    }
    const label = document.getElementById("copy-tab-ai-status-label");
    const bar = document.getElementById("copy-tab-ai-status-bar");
    if (label) label.textContent = text;
    if (bar && progress != null) bar.style.width = `${Math.round(progress * 100)}%`;
    return el;
  }

  function hideStatus() {
    const el = document.getElementById("copy-tab-ai-status");
    if (el) {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }
  }

  // Main
  showStatus("Waiting for editor...", 0);
  const editor = await waitForEditor();
  if (!editor) {
    ERR("Could not find editor after 20s");
    showStatus("Could not find editor. Please try refreshing the page.", null);
    setTimeout(hideStatus, 5000);
    return;
  }

  LOG("Editor found:", editor.className);
  await sleep(500);

  // Find or create file input for uploading files
  async function findFileInput() {
    // Check for existing file input
    let input = document.querySelector('input[type="file"]');
    if (input) {
      LOG("Found existing file input");
      return input;
    }

    // Try clicking the attachment/add button to trigger file input creation
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      const btnText = (btn.textContent || "").toLowerCase().trim();
      if (label.includes("attach") || label.includes("upload") || label.includes("add file") ||
          label.includes("add content") || btnText === "+" || btn.querySelector('svg[class*="plus"]')) {
        LOG(`Clicking button to trigger file input: "${label || btnText}"`);
        btn.click();
        await sleep(500);
        input = document.querySelector('input[type="file"]');
        if (input) {
          LOG("File input appeared after button click");
          return input;
        }
      }
    }

    return null;
  }

  // Upload files using multiple strategies
  async function uploadFiles(files) {
    if (!Array.isArray(files)) files = [files];
    const methods = [];

    // Strategy 1: Clipboard paste event (fast, works on simple editors and some SPAs)
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      editor.focus();
      editor.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
      );
      LOG("Strategy 1 (paste): dispatched");
      methods.push("paste");
    } catch (err) {
      LOG("Strategy 1 (paste) failed:", err.message);
    }

    // Strategy 2: File input (most reliable for Claude.ai which may ignore untrusted paste)
    const input = await findFileInput();
    if (input) {
      try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        LOG(`Strategy 2 (file input): ${files.length} files set, accept="${input.accept}"`);
        methods.push("file-input");
      } catch (err) {
        LOG("Strategy 2 (file input) failed:", err.message);
      }
    }

    // Strategy 3: Drag and drop
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const dropTarget = editor.closest("form") || editor.closest("[class*='composer']") || editor.parentElement || editor;
      dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(50);
      dropTarget.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(50);
      dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      LOG("Strategy 3 (drag-drop): dispatched");
      methods.push("drag-drop");
    } catch (err) {
      LOG("Strategy 3 (drag-drop) failed:", err.message);
    }

    if (methods.length === 0) {
      ERR("All upload strategies failed");
    }
    return methods.join("+");
  }

  // Handle PDF: upload the file directly
  if (pageData.isPdf && pageData.pdfBase64) {
    LOG("PDF mode: uploading file", pageData.pdfFilename, `(${Math.round(pageData.pdfBase64.length / 1024)}KB base64)`);
    showStatus("Uploading PDF...", 0.2);

    const binaryStr = atob(pageData.pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const pdfFile = new File([bytes], pageData.pdfFilename || "document.pdf", {
      type: "application/pdf",
    });

    const method = await uploadFiles(pdfFile);
    LOG("PDF upload method used:", method);

    await sleep(3000);
    showStatus("PDF uploaded!", 1);
    setTimeout(hideStatus, 2000);
    await chrome.storage.local.remove(["pageData", "promptSuffix"]);
    return;
  }

  // Normal page: select top images by importance
  const allImages = pageData.imageItems || pageData.content.filter((item) => item.type === "image");
  LOG(`Total images in pageData: ${allImages.length}`);
  allImages.forEach((img, i) => {
    LOG(`  image[${i}]: index=${img.index}, type=${img.type}, score=${img.score}, hasDataUrl=${!!img.dataUrl}, dataUrlSize=${img.dataUrl ? Math.round(img.dataUrl.length / 1024) + 'KB' : 'N/A'}`);
  });

  const { kept: images, truncated: truncatedCount, keptIndices } = selectTopImages(allImages);
  LOG(`Keeping ${images.length} images, truncated ${truncatedCount}`);

  let text = buildTextContent(pageData, keptIndices, truncatedCount);
  if (pageData.promptSuffix) {
    text += pageData.promptSuffix;
    LOG("Appended promptSuffix:", pageData.promptSuffix.substring(0, 60));
  }
  LOG(`Built text content: ${text.length} chars`);

  // Insert text FIRST so it's guaranteed to appear even if images fail
  showStatus("Inserting text...", 0.1);
  const inserted = insertText(editor, text);
  LOG("Text insertion result:", inserted);

  if (!inserted) {
    ERR("All text insertion methods failed, copying to clipboard as fallback");
    try {
      await navigator.clipboard.writeText(text);
      LOG("Text copied to clipboard");
    } catch (err) {
      ERR("Clipboard write also failed:", err);
    }
  }

  // Then paste images
  if (images.length > 0) {
    const imgLabel = truncatedCount > 0
      ? `Uploading top ${images.length} of ${allImages.length} images...`
      : `Uploading ${images.length} images...`;
    showStatus(imgLabel, 0.3);
    LOG("Starting image paste...");
    await pasteImages(editor, images);
    LOG("All images pasted");
    showStatus(imgLabel, 0.9);
  }

  const truncMsg = truncatedCount > 0 ? ` (${truncatedCount} truncated)` : "";
  if (inserted) {
    showStatus(`Done! ${images.length} images + text pasted.${truncMsg}`, 1);
  } else {
    showStatus("Text copied to clipboard. Press Ctrl+V to paste.", 1);
  }

  LOG("Paste flow complete");
  setTimeout(hideStatus, 3000);

  // Clean up stored data
  await chrome.storage.local.remove(["pageData", "promptSuffix"]);
})();
