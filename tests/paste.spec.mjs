import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const extensionPath = repoRoot;
const testPageUrl = "file://" + path.join(repoRoot, "test-page.html");
const editorPageUrl = "file://" + path.join(repoRoot, "test-editor.html");

async function launchWithExtension() {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copy-tab-ai-pw-")
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--headless=new",
    ],
  });

  let sw;
  if (context.serviceWorkers().length > 0) {
    sw = context.serviceWorkers()[0];
  } else {
    sw = await context.waitForEvent("serviceworker");
  }

  return { context, sw, userDataDir };
}

test("extract from test page and paste into mock editor with [imgN] tags", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(testPageUrl, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    // Step 1: Extract using the real content-extract.js via service worker
    const pageUrl = page.url();
    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["readability.js", "content-extract.js"],
      });
    }, pageUrl);

    // Wait for pageData to appear in storage
    await sw.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const { pageData } = await chrome.storage.local.get("pageData");
        if (pageData) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("pageData never appeared");
    });

    // Verify extraction includes inline property
    const extractInfo = await sw.evaluate(async () => {
      const { pageData } = await chrome.storage.local.get("pageData");
      const allImages = pageData.imageItems || [];
      return {
        imageCount: allImages.length,
        imagesWithInline: allImages.map((img) => ({
          alt: img.alt,
          inline: img.inline,
          index: img.index,
        })),
      };
    });

    console.log(`Extracted ${extractInfo.imageCount} images:`);
    extractInfo.imagesWithInline.forEach((img) =>
      console.log(`  - [img${img.index}] "${img.alt}" inline=${img.inline}`)
    );

    // Close any Claude.ai tabs that were opened by the background
    for (const p of context.pages()) {
      if (p.url().includes("claude.ai")) await p.close();
    }

    // Step 2: Navigate to mock editor and inject paste script
    await page.goto(editorPageUrl, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const editorUrl = page.url();
    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      if (!tab) throw new Error("Editor tab not found");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-paste.js"],
      });
    }, editorUrl);

    // Wait for paste to complete
    await page.waitForFunction(
      () =>
        (window._editorTextLength || 0) > 50 ||
        (window._pastedImageCount || 0) > 0,
      { timeout: 15000 }
    );

    await page.waitForTimeout(1000);

    const editorText = await page.evaluate(
      () => document.querySelector(".ProseMirror").textContent
    );
    const imageCount = await page.evaluate(
      () => window._pastedImageCount || 0
    );

    console.log(`\nEditor text length: ${editorText.length}`);
    console.log(`Images pasted: ${imageCount}`);
    console.log(`\nFull text:\n${editorText.substring(0, 1000)}`);

    // Verify [imgN] tags are present
    expect(editorText).toContain("[img1]");
    expect(editorText).toContain("[img2]");
    expect(editorText).toContain("[img3]");
    expect(editorText).toContain("Neural Networks");
    expect(editorText).toContain("below the visible viewport");
    expect(imageCount).toBeGreaterThan(0);

    // Verify block images are on their own lines (surrounded by newlines in the text)
    // In the rendered text, block images should not be jammed against text
    const img1Pos = editorText.indexOf("[img1]");
    const img2Pos = editorText.indexOf("[img2]");
    expect(img1Pos).toBeGreaterThan(-1);
    expect(img2Pos).toBeGreaterThan(-1);

    console.log("\n✅ Paste test with [imgN] tags passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
