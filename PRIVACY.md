# Privacy Policy — Copy Tab to AI

**Last updated:** March 22, 2026

## Data Collection

Copy Tab to AI does **not** collect, transmit, or store any personal data. The extension operates entirely locally in your browser.

## What the extension accesses

- **Active tab content**: When you click the extension and choose an action, it reads text and images from the current page. This data is stored temporarily in local browser storage (`chrome.storage.local`) and deleted immediately after pasting into the target AI chat.
- **Saved prompts**: Your custom saved prompts are stored in `chrome.storage.sync` so they persist across sessions and sync across your Chrome browsers. No prompt data is sent to any external server.
- **Target AI preference**: Your chosen AI target (Claude, ChatGPT, or custom URL) is stored in `chrome.storage.sync`.

## Data sharing

No data is shared with the extension developer or any third party. Page content is sent only to the AI chat service you select (e.g., Claude.ai, ChatGPT), by opening it in a new browser tab — the same as if you copied and pasted manually.

## Permissions

- `activeTab` / `scripting`: To read the current page and inject the paste script into the AI chat tab.
- `storage`: To temporarily store extracted content and your preferences.
- `<all_urls>`: To fetch images that are blocked by CORS policies (cross-origin images cannot be read from the page directly).

## Contact

For questions about this policy, open an issue at https://github.com/kwanUm/copy-tab-to-ai/issues.
