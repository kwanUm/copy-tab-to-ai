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

test("truncates to top 7 images when page has many images", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());

    // Create synthetic pageData with 12 images of varying scores
    const fakeImages = [];
    // Create a tiny valid 1x1 PNG data URL for testing
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    for (let i = 1; i <= 12; i++) {
      fakeImages.push({
        type: "image",
        dataUrl: tinyPng,
        alt: `Image ${i}`,
        index: i,
        inline: i === 5, // make one inline
        score: i * 100 + (i === 3 ? 500 : 0), // img3 gets a big boost
      });
    }

    const fakePageData = {
      title: "Test Page with Many Images",
      url: "https://example.com/many-images",
      content: [
        { type: "text", value: "Introduction paragraph." },
        { type: "image", index: 1, inline: false, score: 100 },
        { type: "text", value: "Some text with [img5] an inline image reference." },
        { type: "image", index: 2, inline: false, score: 200 },
        { type: "text", value: "Middle paragraph." },
        { type: "image", index: 3, inline: false, score: 800 },
        { type: "image", index: 4, inline: false, score: 400 },
        { type: "text", value: "Another paragraph." },
        { type: "image", index: 6, inline: false, score: 600 },
        { type: "image", index: 7, inline: false, score: 700 },
        { type: "image", index: 8, inline: false, score: 800 },
        { type: "image", index: 9, inline: false, score: 900 },
        { type: "image", index: 10, inline: false, score: 1000 },
        { type: "image", index: 11, inline: false, score: 1100 },
        { type: "image", index: 12, inline: false, score: 1200 },
        { type: "text", value: "Final paragraph." },
      ],
      imageItems: fakeImages,
    };

    await sw.evaluate(async (data) => {
      await chrome.storage.local.set({ pageData: data });
    }, fakePageData);

    // Navigate to mock editor and paste
    await page.goto(editorPageUrl, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const editorUrl = page.url();
    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-paste.js"],
      });
    }, editorUrl);

    await page.waitForFunction(
      () => (window._editorTextLength || 0) > 30,
      { timeout: 15000 }
    );
    await page.waitForTimeout(1000);

    const editorText = await page.evaluate(
      () => document.querySelector(".ProseMirror").textContent
    );
    const imageCount = await page.evaluate(
      () => window._pastedImageCount || 0
    );

    console.log(`Images pasted: ${imageCount}`);
    console.log(`\nFull text:\n${editorText}`);

    // Should only paste 7 images
    expect(imageCount).toBe(7);

    // Should have truncation notice
    expect(editorText).toContain("5 additional images from the page not included");

    // Top 7 by score: img12(1200), img11(1100), img10(1000), img9(900),
    // img3(800), img8(800), img7(700)
    // Dropped: img1(100), img2(200), img5(500+inline), img4(400), img6(600)

    // The highest-scored images should still have their [imgN] tags
    expect(editorText).toContain("[img12]");
    expect(editorText).toContain("[img11]");
    expect(editorText).toContain("[img3]");

    // Low-score image tags should be stripped
    expect(editorText).not.toContain("[img1]");
    expect(editorText).not.toContain("[img2]");

    console.log("\n✅ Truncation test passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
