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

test("downloads PDF and stores for upload", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());

    const pdfUrl =
      "https://proceedings.neurips.cc/paper_files/paper/2022/file/10a6bdcabbd5a3d36b760daa295f63c1-Paper-Conference.pdf";

    await page.goto(pdfUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // Trigger extraction via service worker
    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      if (!tab) throw new Error("PDF tab not found");

      const isPdf =
        /\.pdf(\?|#|$)/i.test(tab.url) || /\/pdf\//i.test(tab.url);
      const script = isPdf ? "pdf-extract.js" : "content-extract.js";
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [script],
      });
    }, pdfUrl);

    // Wait for pageData
    console.log("Waiting for PDF download...");
    await sw.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const { pageData } = await chrome.storage.local.get("pageData");
        if (pageData) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("pageData never appeared");
    });

    const storedData = await sw.evaluate(async () => {
      const { pageData } = await chrome.storage.local.get("pageData");
      return {
        isPdf: pageData.isPdf,
        title: pageData.title,
        url: pageData.url,
        hasPdfBase64: !!pageData.pdfBase64,
        pdfSizeKB: pageData.pdfBase64
          ? Math.round(pageData.pdfBase64.length / 1024)
          : 0,
        pdfFilename: pageData.pdfFilename,
      };
    });

    console.log(`\nPDF stored:`);
    console.log(`  isPdf: ${storedData.isPdf}`);
    console.log(`  filename: ${storedData.pdfFilename}`);
    console.log(`  size: ${storedData.pdfSizeKB} KB`);

    expect(storedData.isPdf).toBe(true);
    expect(storedData.hasPdfBase64).toBe(true);
    expect(storedData.pdfSizeKB).toBeGreaterThan(10);
    expect(storedData.pdfFilename).toContain(".pdf");

    console.log("\n✅ PDF download test passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("PDF uploads as file into editor", async () => {
  const { context, sw, userDataDir } = await launchWithExtension();

  try {
    const page = context.pages()[0] || (await context.newPage());

    const pdfUrl =
      "https://proceedings.neurips.cc/paper_files/paper/2022/file/10a6bdcabbd5a3d36b760daa295f63c1-Paper-Conference.pdf";

    await page.goto(pdfUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["pdf-extract.js"],
      });
    }, pdfUrl);

    await sw.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const { pageData } = await chrome.storage.local.get("pageData");
        if (pageData) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("pageData never appeared");
    });

    // Close Claude.ai tabs
    for (const p of context.pages()) {
      if (p.url().includes("claude.ai")) await p.close();
    }

    // Add PDF file tracking to the mock editor
    await page.goto(editorPageUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      const editor = document.querySelector(".ProseMirror");
      editor.addEventListener("paste", (e) => {
        const files = e.clipboardData?.files;
        if (files) {
          for (const file of files) {
            if (file.type === "application/pdf") {
              window._pastedPdfName = file.name;
              window._pastedPdfSize = file.size;
            }
          }
        }
      });
    });
    await page.waitForTimeout(500);

    // Inject paste script
    const editorUrl = page.url();
    await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-paste.js"],
      });
    }, editorUrl);

    await page.waitForFunction(() => window._pastedPdfSize > 0, {
      timeout: 15000,
    });

    const pdfName = await page.evaluate(() => window._pastedPdfName);
    const pdfSize = await page.evaluate(() => window._pastedPdfSize);

    console.log(`PDF pasted: ${pdfName} (${Math.round(pdfSize / 1024)} KB)`);
    expect(pdfName).toContain(".pdf");
    expect(pdfSize).toBeGreaterThan(10000);

    console.log("\n✅ PDF upload test passed!");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
