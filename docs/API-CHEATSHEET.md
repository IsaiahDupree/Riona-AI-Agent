# Riona API Cheat Sheet

> Quick reference for all public APIs and methods

---

## SafariController

### Import
```typescript
import { SafariController } from './src/client/SafariController';
const safari = new SafariController(30000); // timeout in ms
```

### Browser Control

| Method | Example | Returns |
|--------|---------|---------|
| `launchSafari(url)` | `await safari.launchSafari('https://instagram.com')` | `boolean` |
| `navigateTo(url)` | `await safari.navigateTo('https://google.com')` | `boolean` |
| `getCurrentUrl()` | `const url = await safari.getCurrentUrl()` | `string` |
| `getPageTitle()` | `const title = await safari.getPageTitle()` | `string` |
| `getPageState()` | `const state = await safari.getPageState()` | `PageState` |

### JavaScript Execution

```typescript
// Simple
const title = await safari.executeJS('document.title');

// Complex with JSON return
const data = await safari.executeJS(`
    JSON.stringify({
        url: location.href,
        count: document.querySelectorAll('a').length
    })
`);
const parsed = JSON.parse(data);
```

### Instagram DM Operations

| Method | Description |
|--------|-------------|
| `navigateToDMs()` | Go to `/direct/inbox/` |
| `clickDMTab('primary'|'general'|'requests')` | Switch tabs |
| `getConversations()` | Get `ConversationInfo[]` |
| `clickConversation(index)` | Open by index |
| `getMessagesFromConversation()` | Get `MessageInfo[]` |
| `typeMessage(text)` | Type in input |
| `sendMessage()` | Click send |
| `goBackToInbox()` | Navigate back |
| `iterateAllConversations(callback, max)` | Process all |
| `checkAllDMTabs()` | Get all tabs' conversations |

### Screenshots

```typescript
// Save to file
const path = await safari.takeScreenshot('debug.png');

// Get as base64 (for AI APIs)
const base64 = await safari.getScreenshotBase64();
```

### Notes

```typescript
const notes = await safari.getNotes();        // Get all notes
await safari.createNote('Hello world!');      // Create note
```

---

## BrowserAdapter

### Import & Launch
```typescript
import { launchBrowser, BrowserType } from './src/client/BrowserAdapter';

const browser = await launchBrowser({
    browserType: 'chrome',  // 'chrome' | 'safari' | 'firefox'
    headless: true,
    proxy: 'http://proxy:8080'  // optional
});

const page = await browser.newPage();
```

### UnifiedPage API

| Method | Puppeteer Equiv | Playwright Equiv |
|--------|-----------------|------------------|
| `goto(url)` | `page.goto()` | `page.goto()` |
| `$(selector)` | `page.$()` | `page.$()` |
| `$$(selector)` | `page.$$()` | `page.$$()` |
| `click(selector)` | `page.click()` | `page.click()` |
| `type(selector, text)` | `page.type()` | `page.fill()` + `type()` |
| `evaluate(fn)` | `page.evaluate()` | `page.evaluate()` |
| `cookies()` | `page.cookies()` | `context.cookies()` |
| `screenshot()` | `page.screenshot()` | `page.screenshot()` |

---

## Interfaces

### PageState
```typescript
interface PageState {
    url: string;
    title: string;
    loggedIn: boolean;
    hasLoginForm: boolean;
    hasDMInbox: boolean;
    conversationCount: number;
    currentTab: 'primary' | 'general' | 'requests' | 'unknown';
}
```

### ConversationInfo
```typescript
interface ConversationInfo {
    index: number;
    username: string;
    lastMessage: string;
    timestamp: string;
    isUnread: boolean;
    isGroup: boolean;
}
```

### MessageInfo
```typescript
interface MessageInfo {
    sender: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    type: 'text' | 'image' | 'video' | 'link' | 'other';
}
```

### NoteInfo
```typescript
interface NoteInfo {
    username: string;
    content: string;
    timestamp: string;
    isOwn: boolean;
}
```

---

## AI Agent

### Generate Comment
```typescript
import { runAgent } from './src/Agent';

const result = await runAgent('Generate a comment for a travel photo of Paris');
// Returns: { comment, sentiment, relevance, emojis, hashtags }
```

---

## Logger

```typescript
import { logger } from './src/utils/logger';

logger.info('Message', { key: 'value' });
logger.warn('Warning');
logger.error('Error', error);
logger.debug('Debug info');
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BROWSER_TYPE` | `chrome`, `safari`, `firefox` | `chrome` |
| `IG_USERNAME` | Instagram username | - |
| `IG_PASSWORD` | Instagram password | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `WEB_SERVER_ENABLED` | Enable REST API | `false` |
| `PORT` | Server port | `3000` |

---

## NPM Scripts

```bash
npm start              # Run Instagram automation
npm run build          # Compile TypeScript
npm run dev            # Dev mode
npm run test:safari:dm # Test Safari DM
npm run dm:requests    # Process DM requests
npm run extract:dms    # Extract all DMs
```

---

## Quick Patterns

### Wait/Delay
```typescript
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
await delay(2000);
```

### Retry Logic
```typescript
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) { if (i === attempts - 1) throw e; }
        await delay(1000);
    }
    throw new Error('Retry failed');
}
```

### Check Login State
```typescript
const state = await safari.getPageState();
if (state.hasLoginForm || !state.loggedIn) {
    console.log('Not logged in!');
}
```

---

## Common Selectors (Instagram)

```javascript
// Profile picture
'img[alt*="profile picture"]'

// Like button
'svg[aria-label="Like"]'

// Comment input
'textarea[placeholder*="comment"]'

// Send button
'button[type="submit"]'
'[aria-label*="Send"]'

// DM conversation links
'a[href*="/direct/t/"]'

// Message input
'textarea[placeholder*="Message"]'
'div[contenteditable="true"][role="textbox"]'
```
