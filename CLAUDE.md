# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chrome extension (Manifest V3) that extracts all text and images from any web page or PDF, opens Claude.ai, and pastes everything into the editor. Images are referenced as `[img1]`, `[img2]` etc. in the text, limited to the top 7 most important by a scoring heuristic.

## Commands

```bash
npm test                                    # Run all 6 Playwright tests (serial, ~2.5 min)
npm run test:extract                        # Run only extraction tests
npx playwright test tests/paste.spec.mjs    # Run a single test file
npx playwright test --reporter=line         # Compact output
```

No build step — scripts are injected directly by the extension runtime.

## Architecture

Three-phase pipeline orchestrated by the background service worker:

**Phase 1 — Extract** (`content-extract.js` + `readability.js`)
- Injected into the source page when the user clicks the extension icon
- Uses Mozilla Readability to isolate article content, falls back to DOM selectors (`article`, `main`, `.w-richtext`, etc.)
- TreeWalker collects text + images in reading order
- Cross-origin images skip canvas immediately (avoids 5s load timeout per image) and are sent as URL references to the background
- Sends `PAGE_DATA_EXTRACTED` message with content array + imageItems array

**Phase 2 — Resolve** (`background.js`)
- Receives extraction data, fetches any cross-origin `image_url` items using the service worker's `<all_urls>` host permission (no CORS)
- 15s total timeout for all image fetches; proceeds with whatever resolved
- Stores final `pageData` in `chrome.storage.local`, opens `claude.ai/new`, injects paste script

**Phase 3 — Paste** (`content-paste.js`)
- Waits for Claude.ai's `contenteditable` editor (20s timeout)
- Inserts text first (execCommand → InputEvent → ClipboardEvent fallback)
- Uploads images/PDFs via three strategies tried in sequence: ClipboardEvent paste → hidden `<input type="file">` → drag-and-drop

PDFs take a separate path: `pdf-extract.js` downloads the PDF binary via the background, stores as base64, and `content-paste.js` uploads it as a file.

## Message Types (content script ↔ background)

| Message | Direction | Purpose |
|---|---|---|
| `PAGE_DATA_EXTRACTED` | content → bg | Extracted text + image refs |
| `FETCH_IMAGE` | content → bg | Single CORS image fetch |
| `FETCH_PDF` | content → bg | Download PDF binary |
| `OPEN_CLAUDE_AND_PASTE` | content → bg | Open Claude.ai tab |
| `GET_PAGE_DATA` | paste → bg | Retrieve stored pageData |

## Image Scoring

Images are ranked by `scoreImage()` in `content-extract.js`. Key factors: pixel area (up to +500), aspect ratio (+50 if < 3:1), alt text (+80), inside article/figure (+100), position on page (up to +30). Penalties: avatar/logo/icon (-150 to -200), header/footer/nav (-150). Images scoring below -50 are dropped entirely.

## Testing

Tests use Playwright with `chromium.launchPersistentContext` to load the extension in a real Chrome instance. The pattern is:

1. Launch Chrome with `--load-extension` and get the service worker handle
2. Navigate to a page, inject scripts via `sw.evaluate` → `chrome.scripting.executeScript`
3. Poll `chrome.storage.local` for `pageData` to confirm extraction completed
4. For paste tests, navigate to `test-editor.html` (mock ProseMirror editor) and inject `content-paste.js`

Tests must run with `workers: 1` — each test needs its own Chrome instance with a fresh extension load. The Substack extraction test hits a real URL and is the slowest.

`test-page.html` has intentional test fixtures: below-fold content, hidden sections, inline icons, block images.
`test-editor.html` mocks Claude.ai's contenteditable div and tracks pasted images/files via `window._pastedImageCount`.
