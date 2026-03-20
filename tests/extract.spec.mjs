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

  // Wait for service worker
  let sw;
  if (context.serviceWorkers().length > 0) {
    sw = context.serviceWorkers()[0];
  } else {
    sw = await context.waitForEvent("serviceworker");
  }
  const extensionId = sw.url().split("/")[2];
  console.log(`Extension ID: ${extensionId}`);

  return { context, sw, extensionId, userDataDir };
}

// Helper: trigger extraction on a specific tab via the service worker
async function triggerExtraction(sw, page) {
  const pageUrl = page.url();
  await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error("Tab not found for url: " + url);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["readability.js", "content-extract.js"],
    });
  }, pageUrl);
}

test("extension extracts text and images from test page", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(testPageUrl, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    // Trigger extraction via extension's service worker
    await triggerExtraction(sw, page);

    // Wait for extraction to complete by checking storage
    await page.waitForSelector("#copy-tab-ai-indicator", { timeout: 10000 });
    console.log("Indicator appeared");

    // Wait for pageData to appear in storage (the real signal of completion)
    await sw.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const { pageData } = await chrome.storage.local.get("pageData");
        if (pageData) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("pageData never appeared in storage");
    });
    // Verify stored data via service worker
    const storedData = await sw.evaluate(async () => {
      const { pageData } = await chrome.storage.local.get("pageData");
      if (!pageData) return null;
      return {
        title: pageData.title,
        contentLength: pageData.content.length,
        textItems: pageData.content.filter((i) => i.type === "text").length,
        imageItems: pageData.content.filter(
          (i) => i.type === "image"
        ).length,
        sampleText: pageData.content
          .filter((i) => i.type === "text")
          .slice(0, 3)
          .map((i) => i.value.substring(0, 100)),
        hasBelow: pageData.content.some(
          (i) =>
            i.type === "text" &&
            i.value.includes("below the visible viewport")
        ),
      };
    });

    console.log(`\nStored data:`);
    console.log(`  Title: ${storedData.title}`);
    console.log(`  Text items: ${storedData.textItems}`);
    console.log(`  Image items: ${storedData.imageItems}`);
    console.log(
      `  Contains below-fold content: ${storedData.hasBelow}`
    );
    console.log(`  Sample text:`);
    storedData.sampleText.forEach((t) => console.log(`    - ${t}`));

    expect(storedData.textItems).toBeGreaterThan(5);
    expect(storedData.hasBelow).toBe(true);

    console.log("\n✅ Test page extraction passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("extension extracts from real Substack article", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(
      "https://newsletter.languagemodels.co/p/the-illustrated-gpt-oss",
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    // Wait for images to start loading
    await page.waitForTimeout(3000);

    // Trigger extraction via service worker
    await triggerExtraction(sw, page);

    // Wait for extraction to complete via storage
    await page.waitForSelector("#copy-tab-ai-indicator", { timeout: 15000 });
    console.log("Extraction started");

    await sw.evaluate(async () => {
      for (let i = 0; i < 120; i++) {
        const { pageData } = await chrome.storage.local.get("pageData");
        if (pageData) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("pageData never appeared in storage");
    });

    // Verify stored data
    const storedData = await sw.evaluate(async () => {
      const { pageData } = await chrome.storage.local.get("pageData");
      if (!pageData) return null;
      return {
        title: pageData.title,
        url: pageData.url,
        contentLength: pageData.content.length,
        textItems: pageData.content.filter((i) => i.type === "text").length,
        imageItems: pageData.content.filter(
          (i) => i.type === "image"
        ).length,
        sampleText: pageData.content
          .filter((i) => i.type === "text")
          .slice(0, 5)
          .map((i) => i.value.substring(0, 100)),
      };
    });

    expect(storedData).toBeTruthy();
    console.log(`\nStored data:`);
    console.log(`  Title: ${storedData.title}`);
    console.log(`  Total items: ${storedData.contentLength}`);
    console.log(`  Text: ${storedData.textItems}, Images: ${storedData.imageItems}`);
    console.log(`  Sample text:`);
    storedData.sampleText.forEach((t) => console.log(`    - ${t}`));

    expect(storedData.textItems).toBeGreaterThan(10);
    expect(storedData.imageItems).toBeGreaterThan(0);

    console.log("\n✅ Substack extraction test passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
