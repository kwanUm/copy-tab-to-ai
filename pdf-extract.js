// PDF handling: fetch the PDF and store it for upload to Claude.ai
(async () => {
  "use strict";

  function createIndicator() {
    const div = document.createElement("div");
    div.id = "copy-tab-ai-indicator";
    Object.assign(div.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      zIndex: "999999",
      background: "#1a1a2e",
      color: "white",
      padding: "12px 16px",
      borderRadius: "10px",
      fontSize: "13px",
      fontFamily: "system-ui, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      transition: "opacity 0.3s",
      minWidth: "220px",
    });

    const label = document.createElement("div");
    label.id = "copy-tab-ai-label";
    label.textContent = "Downloading PDF...";
    div.appendChild(label);

    const track = document.createElement("div");
    Object.assign(track.style, {
      marginTop: "8px",
      height: "4px",
      borderRadius: "2px",
      background: "rgba(255,255,255,0.15)",
      overflow: "hidden",
    });
    const bar = document.createElement("div");
    bar.id = "copy-tab-ai-bar";
    Object.assign(bar.style, {
      height: "100%",
      width: "0%",
      borderRadius: "2px",
      background: "#6c7cff",
      transition: "width 0.3s ease",
    });
    track.appendChild(bar);
    div.appendChild(track);

    document.body.appendChild(div);
    return div;
  }

  function updateIndicator(text, progress) {
    const label = document.getElementById("copy-tab-ai-label");
    const bar = document.getElementById("copy-tab-ai-bar");
    if (label) label.textContent = text;
    if (bar && progress != null)
      bar.style.width = `${Math.round(progress * 100)}%`;
  }

  function removeIndicator() {
    const div = document.getElementById("copy-tab-ai-indicator");
    if (div) {
      div.style.opacity = "0";
      setTimeout(() => div.remove(), 300);
    }
  }

  createIndicator();

  try {
    const pdfUrl = window.location.href;
    const filename =
      decodeURIComponent(pdfUrl.split("/").pop().split("?")[0]) || "document.pdf";

    // Fetch PDF via background (avoids CORS)
    updateIndicator("Downloading PDF...", 0.2);
    const resp = await chrome.runtime.sendMessage({
      type: "FETCH_PDF",
      url: pdfUrl,
    });

    if (resp.error) throw new Error("Failed to download PDF: " + resp.error);

    updateIndicator("Preparing upload...", 0.7);

    // Store as pageData with a special pdf flag
    await chrome.storage.local.set({
      pageData: {
        url: pdfUrl,
        title: filename,
        isPdf: true,
        pdfBase64: resp.data,
        pdfFilename: filename,
        content: [],
        imageItems: [],
      },
    });

    updateIndicator("Opening Claude.ai...", 0.9);
    await chrome.runtime.sendMessage({ type: "OPEN_CLAUDE_AND_PASTE" });

    updateIndicator("Done!", 1);
    setTimeout(removeIndicator, 2000);
  } catch (err) {
    updateIndicator(`Error: ${err.message}`, null);
    const div = document.getElementById("copy-tab-ai-indicator");
    if (div) div.style.background = "#e74c3c";
    console.error("PDF download error:", err);
    setTimeout(removeIndicator, 5000);
  }
})();
