# Copy Tab to AI

A Chrome extension that extracts all text and images from any web page, opens your AI chatbot of choice, and pastes everything into the editor — ready to ask questions.

**One click. Full page. Images included.**

## Features

- **Full page extraction** — captures all text and images, including below-the-fold content
- **Smart image handling** — scores images by importance (size, context, position), keeps the top 7, places `[img1]` `[img2]` references in the text
- **Reader mode** — uses Mozilla Readability to strip nav, ads, and footer noise
- **PDF support** — downloads and uploads PDFs directly as files
- **Multiple AI targets** — Claude, ChatGPT, or any custom URL
- **Popup UI** — Summarize button, custom question input, saved prompts that persist across sessions
- **Progress indicators** — visual feedback during extraction and pasting

## Install

### From source (developer mode)

1. Clone this repo
2. `npm install`
3. Open `chrome://extensions` in Chrome
4. Enable "Developer mode"
5. Click "Load unpacked" and select the project folder

### Run tests

```bash
npm test
```

## How it works

1. Click the extension icon → popup appears
2. Choose your target AI (Claude, ChatGPT, or custom URL)
3. Click **Summarize**, type a question, or pick a saved prompt
4. Extension extracts text + images from the current page using Readability
5. Opens your chosen AI in a new tab and pastes everything into the editor

## Architecture

```
popup.js  →  background.js  →  content-extract.js (source page)
                             →  content-paste.js   (AI chat page)
```

- **popup.js** — UI for target selection, prompts, and triggering extraction
- **background.js** — orchestrates the flow, fetches CORS-blocked images, manages tabs
- **content-extract.js** — injected into source page, walks the DOM with Readability, captures images via canvas or background fetch
- **content-paste.js** — injected into AI chat page, inserts text and uploads images/PDFs

## License

MIT
