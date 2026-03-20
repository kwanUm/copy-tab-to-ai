// Content script: extracts all text and images from the full page
// Uses Mozilla Readability (if available) to focus on article content
(async () => {
  "use strict";

  const LOG = (...args) => console.log("[Copy Tab to AI]", ...args);
  const ERR = (...args) => console.error("[Copy Tab to AI]", ...args);

  LOG("content-extract.js loaded on", window.location.href);

  const MAX_IMAGE_DIMENSION = 1600;

  // Try to get a clean article root using Readability
  function getArticleRoot() {
    // Try Readability first (injected as readability.js before this script)
    if (typeof Readability === "function") {
      LOG("Readability available, attempting parse...");
      try {
        const clone = document.cloneNode(true);
        const article = new Readability(clone).parse();
        if (article && article.content) {
          const imgCount = (article.content.match(/<img/g) || []).length;
          LOG(`Readability parsed: "${article.title}", ${article.content.length} chars HTML, ${imgCount} images`);
          // Parse the clean HTML back to a DOM subtree
          const container = document.createElement("div");
          container.innerHTML = article.content;

          // Now map images back to original DOM elements for proper scoring/capture
          // Readability strips classes/styles, so we need originals for canvas capture
          return { root: container, title: article.title, useOriginalImages: true };
        }
      } catch (err) {
        LOG("Readability failed, falling back to full page:", err.message);
      }
    } else {
      LOG("Readability not available (readability.js not injected?)");
    }

    // Fallback: look for common article containers in the original DOM
    const selectors = [
      "article", "[role='main']", "main",
      ".post-content", ".article-body", ".entry-content",
      ".blog-content", ".w-richtext", ".prose",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) {
        LOG(`Using fallback content root: ${sel}`);
        return { root: el, title: document.title, useOriginalImages: false };
      }
    }

    LOG("No article root found, using document.body");
    return { root: document.body, title: document.title, useOriginalImages: false };
  }

  async function extractPageContent() {
    const content = [];
    const imageItems = [];
    const processedImages = new Set();
    let imageIndex = 0;

    const { root, title, useOriginalImages } = getArticleRoot();

    // Count images for progress
    const totalImages = root.querySelectorAll("img").length || 1;
    let processedCount = 0;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // For Readability output, we don't need style checks (it's clean HTML)
            if (!useOriginalImages) {
              const style = getComputedStyle(node);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0"
              ) {
                return NodeFilter.FILTER_REJECT;
              }
            }
            const tag = node.tagName.toLowerCase();
            if (["script", "style", "noscript", "link", "meta"].includes(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (node.id === "copy-tab-ai-indicator") {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let node;
    let currentText = "";

    function flushText() {
      const trimmed = currentText.trim().replace(/\s+/g, " ");
      if (trimmed.length > 0) {
        content.push({ type: "text", value: trimmed });
      }
      currentText = "";
    }

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text.trim()) {
          currentText += text;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();

        // Block elements flush text
        if (useOriginalImages) {
          // For Readability output, check tag-level block elements
          const blockTags = ["div", "p", "h1", "h2", "h3", "h4", "h5", "h6",
            "blockquote", "pre", "ul", "ol", "li", "table", "tr", "section",
            "figure", "figcaption"];
          if (blockTags.includes(tag) || tag === "br" || tag === "hr") {
            flushText();
          }
        } else {
          const style = getComputedStyle(node);
          const isBlock =
            style.display === "block" ||
            style.display === "flex" ||
            style.display === "grid" ||
            style.display === "table" ||
            style.display === "list-item";
          if (isBlock || tag === "br" || tag === "hr") {
            flushText();
          }
        }

        // Handle images
        if (tag === "img") {
          let src = node.src || node.dataset.src || node.dataset.lazySrc;
          if (!src) continue;

          // In reader mode, the img src from Readability may differ from original
          // Try to find the image in the original DOM
          let originalImg = node;
          if (useOriginalImages) {
            // Look up the original img by src
            originalImg = document.querySelector(`img[src="${CSS.escape(src)}"]`)
              || document.querySelector(`img[data-src="${CSS.escape(src)}"]`)
              || node;
            // Also try matching by filename
            if (originalImg === node) {
              const filename = src.split("/").pop().split("?")[0];
              if (filename) {
                const allImgs = document.querySelectorAll("img");
                for (const candidate of allImgs) {
                  const candidateSrc = candidate.src || candidate.dataset.src || "";
                  if (candidateSrc.includes(filename)) {
                    originalImg = candidate;
                    src = candidateSrc;
                    break;
                  }
                }
              }
            }
          }

          if (processedImages.has(src)) continue;
          processedImages.add(src);
          processedCount++;
          updateIndicator(
            `Extracting... (${processedCount}/${totalImages} images)`,
            (processedCount / totalImages) * 0.85
          );

          if (!isWorthCapturing(originalImg, src)) continue;
          const inline = isInlineImage(originalImg);
          const result = await captureImage(originalImg, src);
          if (result) {
            LOG(`img: score=${result.score}, type=${result.type}, size=${result.dataUrl ? Math.round(result.dataUrl.length / 1024) + 'KB' : 'url-ref'}, inline=${inline}`);
            if (inline) {
              imageIndex++;
              result.index = imageIndex;
              result.inline = true;
              imageItems.push(result);
              currentText += ` [img${imageIndex}] `;
            } else {
              flushText();
              imageIndex++;
              result.index = imageIndex;
              result.inline = false;
              content.push(result);
              imageItems.push(result);
            }
          }
        }

        // Handle picture elements (only in non-reader mode)
        if (!useOriginalImages && tag === "picture") {
          const img = node.querySelector("img");
          if (img) {
            const src = img.src || img.dataset.src;
            if (src && !processedImages.has(src)) {
              processedImages.add(src);
              if (!isWorthCapturing(img, src)) continue;
              const inline = isInlineImage(img);
              const result = await captureImage(img, src);
              if (result) {
                if (inline) {
                  imageIndex++;
                  result.index = imageIndex;
                  result.inline = true;
                  imageItems.push(result);
                  currentText += ` [img${imageIndex}] `;
                } else {
                  flushText();
                  imageIndex++;
                  result.index = imageIndex;
                  result.inline = false;
                  content.push(result);
                  imageItems.push(result);
                }
              }
            }
          }
        }
      }
    }

    flushText();
    return { content, imageItems, title };
  }

  // Determine if an image is inline with text or a standalone block image
  function isInlineImage(img) {
    // If img is from Readability DOM (no computed style), treat as block
    if (!img.isConnected) return false;
    try {
      const style = getComputedStyle(img);
      if (style.display === "block" || style.display === "flex") return false;
    } catch {
      return false;
    }
    const rect = img.getBoundingClientRect();
    if (rect.width > 300 && rect.height > 200) return false;
    const parent = img.parentElement;
    if (parent) {
      const parentTag = parent.tagName.toLowerCase();
      if (parentTag === "figure" || parentTag === "picture") return false;
      try {
        const parentStyle = getComputedStyle(parent);
        if (
          (parentStyle.display === "block" || parentStyle.display === "flex") &&
          parent.children.length === 1 &&
          parent.textContent.trim().length < 5
        ) {
          return false;
        }
      } catch {}
    }
    return true;
  }

  // Score an image's importance (higher = more important)
  function scoreImage(img) {
    let score = 0;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    const area = w * h;

    score += Math.min(area / 1000, 500);

    if (w > 0 && h > 0) {
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio < 3) score += 50;
    }

    if (img.alt && img.alt.length > 5) score += 80;

    if (img.isConnected) {
      const ancestor = img.closest("figure, article, main, .post-content, .article-body, .entry-content");
      if (ancestor) score += 100;

      const src = (img.src || "").toLowerCase();
      const cls = (img.className || "").toLowerCase();
      if (src.includes("avatar") || src.includes("profile") || cls.includes("avatar")) score -= 200;
      if (src.includes("logo") || cls.includes("logo")) score -= 200;
      if (src.includes("icon") || cls.includes("icon")) score -= 150;
      if (src.includes("emoji") || cls.includes("emoji")) score -= 150;
      if (src.includes("badge") || cls.includes("badge")) score -= 100;
      if (src.includes("spinner") || src.includes("loading")) score -= 200;

      if (img.closest("header, footer, nav, aside")) score -= 150;

      const rect = img.getBoundingClientRect();
      const docHeight = document.documentElement.scrollHeight || 1;
      const positionRatio = (rect.top + window.scrollY) / docHeight;
      score += Math.max(0, 30 * (1 - positionRatio));
    }

    return score;
  }

  // Pre-check if an image is worth capturing
  function isWorthCapturing(img, src) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && w < 30) return false;
    if (h > 0 && h < 30) return false;

    if (src.endsWith(".svg") || src.includes(".svg?")) return false;

    const srcLower = (src || "").toLowerCase();
    const cls = (img.className || "").toLowerCase();
    if (srcLower.includes("logo") || cls.includes("logo")) return false;
    if (srcLower.includes("spinner") || srcLower.includes("loading")) return false;
    if (srcLower.includes("menu-open") || srcLower.includes("menu-close")) return false;
    if (srcLower.includes("navbar_arrow") || srcLower.includes("nav-arrow")) return false;

    if (img.isConnected && img.closest("nav") && w < 100 && h < 100) return false;

    return true;
  }

  function isCrossOrigin(src) {
    try {
      const imgUrl = new URL(src, window.location.href);
      return imgUrl.origin !== window.location.origin;
    } catch {
      return true;
    }
  }

  async function captureImage(img, src) {
    const alt = img.alt || "";

    if (img.naturalWidth && img.naturalWidth < 30) return null;
    if (img.naturalHeight && img.naturalHeight < 30) return null;

    // Cross-origin images can't be canvas-captured — skip straight to URL ref
    // This avoids the 5s load timeout per image that causes "stuck extracting"
    if (isCrossOrigin(src)) {
      const score = scoreImage(img);
      if (score < -50) return null;
      LOG(`Cross-origin image, sending URL to background: ${src.substring(0, 80)}`);
      return { type: "image_url", url: src, alt, score };
    }

    // Same-origin: wait for load then try canvas
    if (!img.complete) {
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          setTimeout(reject, 5000);
        });
      } catch {
        return { type: "image_url", url: src, alt, score: scoreImage(img) };
      }
    }

    const score = scoreImage(img);
    if (score < -50) return null;

    try {
      const canvas = document.createElement("canvas");
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (w < 30 || h < 30) return null;

      if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
        const scale = MAX_IMAGE_DIMENSION / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/png");
      return { type: "image", dataUrl, alt, score };
    } catch {
      return { type: "image_url", url: src, alt, score };
    }
  }

  // Visual indicator with progress bar
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
    label.textContent = "Extracting page content...";
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
    if (bar && progress != null) bar.style.width = `${Math.round(progress * 100)}%`;
  }

  function removeIndicator() {
    const div = document.getElementById("copy-tab-ai-indicator");
    if (div) {
      div.style.opacity = "0";
      setTimeout(() => div.remove(), 300);
    }
  }

  const indicator = createIndicator();

  try {
    const { content: pageContent, imageItems, title } = await extractPageContent();

    const imageCount = imageItems.length;
    const textCount = pageContent.filter((i) => i.type === "text").length;
    LOG(`Extraction complete: ${textCount} text blocks, ${imageCount} images`);
    imageItems.forEach((img, i) => {
      LOG(`  image[${i}]: index=${img.index}, type=${img.type}, score=${img.score}, inline=${img.inline}, size=${img.dataUrl ? Math.round(img.dataUrl.length / 1024) + 'KB' : 'url-ref'}`);
    });
    updateIndicator(`Found ${textCount} text blocks, ${imageCount} images. Sending...`, 0.9);

    LOG("Sending PAGE_DATA_EXTRACTED to background...");
    await chrome.runtime.sendMessage({
      type: "PAGE_DATA_EXTRACTED",
      data: {
        url: window.location.href,
        title: title || document.title,
        content: pageContent,
        imageItems,
      },
    });

    LOG("Message sent, opening Claude.ai...");
    updateIndicator("Opening Claude.ai...", 1);
    setTimeout(removeIndicator, 2000);
  } catch (err) {
    ERR("Extraction error:", err);
    updateIndicator(`Error: ${err.message}`, null);
    indicator.style.background = "#e74c3c";
    setTimeout(removeIndicator, 5000);
  }
})();
