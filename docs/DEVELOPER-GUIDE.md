# Riona Safari Automation - Developer Guide

> **A comprehensive guide for developers looking to use Riona as a tool or take inspiration for AppleScript Safari automation projects.**

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [AppleScript Safari Automation](#applescript-safari-automation)
4. [Core Components](#core-components)
5. [API Reference](#api-reference)
6. [Usage Examples](#usage-examples)
7. [Integration Patterns](#integration-patterns)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)

---

## Overview

Riona is a TypeScript-based automation framework that provides **native Safari browser control via AppleScript** on macOS. Unlike headless browsers or WebDriver-based solutions, this approach uses your actual Safari.app with existing sessions, cookies, and profile data.

### Key Advantages

- **Session Persistence**: Uses your logged-in Safari session—no re-authentication required
- **Native macOS Integration**: Leverages AppleScript for true browser control
- **JavaScript Injection**: Execute arbitrary JS in the browser context
- **Screenshot Capture**: Built-in screenshot functionality
- **Multi-Browser Support**: Unified adapter for Chrome (Puppeteer), Safari (AppleScript), and WebKit (Playwright)

### Requirements

- **macOS** (required for AppleScript)
- **Safari** with Developer Menu enabled
- **System Settings → Privacy & Security → Automation** permissions granted
- **Node.js** v14+
- **TypeScript** (for development)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Riona Architecture                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐     ┌──────────────────┐     ┌──────────────┐  │
│  │   index.ts  │────▶│  Instagram-AI.ts │────▶│    Agent     │  │
│  │  (Entry)    │     │  (Orchestrator)  │     │   (OpenAI)   │  │
│  └─────────────┘     └──────────────────┘     └──────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Browser Layer                          │  │
│  │  ┌─────────────────┐  ┌──────────────────┐               │  │
│  │  │ BrowserAdapter  │  │ SafariController │               │  │
│  │  │ (Unified API)   │  │ (AppleScript)    │               │  │
│  │  └─────────────────┘  └──────────────────┘               │  │
│  │         │                     │                           │  │
│  │         ▼                     ▼                           │  │
│  │  ┌─────────────┐       ┌─────────────┐                   │  │
│  │  │  Puppeteer  │       │  osascript  │                   │  │
│  │  │  Playwright │       │  (macOS)    │                   │  │
│  │  └─────────────┘       └─────────────┘                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Utilities Layer                        │  │
│  │  ┌────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────┐  │  │
│  │  │ Logger │  │ Cookies │  │ Config  │  │ Error Handle │  │  │
│  │  └────────┘  └─────────┘  └─────────┘  └──────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
src/
├── client/                    # Browser automation clients
│   ├── SafariController.ts    # ⭐ AppleScript Safari control
│   ├── BrowserAdapter.ts      # Unified browser interface
│   ├── Instagram-AI.ts        # Instagram automation logic
│   └── Safari*.ts             # Safari-specific implementations
├── Agent/                     # AI content generation
│   ├── index.ts               # OpenAI integration
│   └── training/              # Model training utilities
├── config/                    # Configuration files
├── utils/                     # Utility functions
│   ├── logger.ts              # Winston-based logging
│   └── ...
└── index.ts                   # Main entry point
```

---

## AppleScript Safari Automation

The heart of Safari automation is the `SafariController` class. It uses Node.js `child_process` to execute AppleScript commands that control Safari.

### How It Works

```
┌──────────────────┐     ┌─────────────┐     ┌─────────────┐
│   TypeScript     │────▶│  osascript  │────▶│  Safari.app │
│   (Node.js)      │     │  (shell)    │     │  (browser)  │
└──────────────────┘     └─────────────┘     └─────────────┘
         │                                          │
         │    tell application "Safari"             │
         │      do JavaScript "..."                 │
         └──────────────────────────────────────────┘
```

### Core AppleScript Pattern

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runAppleScript(script: string): Promise<string> {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    const { stdout } = await execAsync(`osascript -e '${escapedScript}'`);
    return stdout.trim();
}
```

### Executing JavaScript in Safari

The key innovation is using AppleScript's `do JavaScript` command:

```typescript
async function executeJS(jsCode: string): Promise<string> {
    // Escape JavaScript for AppleScript embedding
    const escapedJS = jsCode
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');

    const script = `
tell application "Safari"
    tell front window
        tell current tab
            do JavaScript "${escapedJS}"
        end tell
    end tell
end tell`;

    return runAppleScript(script);
}
```

---

## Core Components

### 1. SafariController

**Location**: `src/client/SafariController.ts`

The main class for Safari automation. Key interfaces:

```typescript
// Page state information
interface PageState {
    url: string;
    title: string;
    loggedIn: boolean;
    hasLoginForm: boolean;
    hasDMInbox: boolean;
    conversationCount: number;
    currentTab: 'primary' | 'general' | 'requests' | 'unknown';
}

// Conversation metadata
interface ConversationInfo {
    index: number;
    username: string;
    lastMessage: string;
    timestamp: string;
    isUnread: boolean;
    isGroup: boolean;
}

// Message content
interface MessageInfo {
    sender: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    type: 'text' | 'image' | 'video' | 'link' | 'other';
}
```

### 2. BrowserAdapter

**Location**: `src/client/BrowserAdapter.ts`

Provides a unified interface across browser engines:

```typescript
type BrowserType = 'chrome' | 'safari' | 'firefox';

interface UnifiedPage {
    goto(url: string, options?: object): Promise<any>;
    $(selector: string): Promise<any>;
    $$(selector: string): Promise<any[]>;
    click(selector: string): Promise<void>;
    type(selector: string, text: string): Promise<void>;
    evaluate<T>(fn: Function, ...args: any[]): Promise<T>;
    cookies(): Promise<any[]>;
    screenshot(options?: object): Promise<Buffer>;
    // ... more methods
}
```

### 3. Logger

**Location**: `src/utils/logger.ts`

Winston-based logging with color support:

```typescript
import { logger } from './utils/logger';

logger.info('Operation successful', { component: 'Safari' });
logger.error('Failed to click element', { selector: '.button' });
logger.debug('Page state', { url: 'https://...' });
```

---

## API Reference

### SafariController Methods

#### Browser Control

| Method | Description | Returns |
|--------|-------------|---------|
| `launchSafari(url)` | Open Safari with URL | `Promise<boolean>` |
| `navigateTo(url)` | Navigate current tab | `Promise<boolean>` |
| `getCurrentUrl()` | Get current page URL | `Promise<string>` |
| `getPageTitle()` | Get page title | `Promise<string>` |
| `getPageState()` | Get comprehensive page state | `Promise<PageState>` |

#### JavaScript Execution

| Method | Description | Returns |
|--------|-------------|---------|
| `executeJS(code)` | Run JS in browser context | `Promise<string>` |

#### Instagram DM Operations

| Method | Description | Returns |
|--------|-------------|---------|
| `navigateToDMs()` | Go to Instagram DM inbox | `Promise<boolean>` |
| `clickDMTab(tab)` | Switch DM tab (primary/general/requests) | `Promise<boolean>` |
| `getConversations()` | Get visible conversations | `Promise<ConversationInfo[]>` |
| `clickConversation(index)` | Open a conversation | `Promise<boolean>` |
| `getMessagesFromConversation()` | Get messages from open conversation | `Promise<MessageInfo[]>` |
| `typeMessage(text)` | Type in message input | `Promise<boolean>` |
| `sendMessage()` | Send typed message | `Promise<boolean>` |
| `goBackToInbox()` | Return to inbox view | `Promise<boolean>` |

#### Screenshots

| Method | Description | Returns |
|--------|-------------|---------|
| `takeScreenshot(filename?)` | Save screenshot to file | `Promise<string>` |
| `getScreenshotBase64(filename?)` | Get screenshot as base64 | `Promise<string>` |

#### Notes (Instagram)

| Method | Description | Returns |
|--------|-------------|---------|
| `getNotes()` | Get visible notes | `Promise<NoteInfo[]>` |
| `createNote(text)` | Create a new note | `Promise<boolean>` |

---

## Usage Examples

### Example 1: Basic Safari Control

```typescript
import { SafariController } from './src/client/SafariController';

async function basicExample() {
    const safari = new SafariController(30000); // 30s timeout
    
    // Launch Safari with a URL
    await safari.launchSafari('https://www.instagram.com');
    
    // Wait for page load
    await new Promise(r => setTimeout(r, 3000));
    
    // Get page state
    const state = await safari.getPageState();
    console.log('Page state:', state);
    
    // Execute custom JavaScript
    const result = await safari.executeJS(`
        document.querySelectorAll('a').length
    `);
    console.log('Link count:', result);
}
```

### Example 2: Extract DM Conversations

```typescript
import { SafariController } from './src/client/SafariController';

async function extractDMs() {
    const safari = new SafariController();
    
    // Navigate to DMs (assumes already logged in)
    await safari.navigateToDMs();
    
    // Get all conversations
    const conversations = await safari.getConversations();
    
    for (const conv of conversations) {
        console.log(`${conv.username}: ${conv.lastMessage}`);
        
        // Open conversation
        await safari.clickConversation(conv.index);
        
        // Get messages
        const messages = await safari.getMessagesFromConversation();
        console.log(`  Messages: ${messages.length}`);
        
        // Go back
        await safari.goBackToInbox();
    }
}
```

### Example 3: Send a DM

```typescript
import { SafariController } from './src/client/SafariController';

async function sendDM(recipientIndex: number, message: string) {
    const safari = new SafariController();
    
    await safari.navigateToDMs();
    await safari.clickConversation(recipientIndex);
    
    // Type and send
    const typed = await safari.typeMessage(message);
    if (typed) {
        await safari.sendMessage();
        console.log('Message sent!');
    }
}
```

### Example 4: Custom JavaScript Injection

```typescript
async function customAutomation() {
    const safari = new SafariController();
    
    // Complex DOM manipulation
    const result = await safari.executeJS(`
        (function() {
            // Find and click a specific element
            const button = document.querySelector('button[aria-label="Like"]');
            if (button) {
                button.click();
                return 'clicked';
            }
            return 'not_found';
        })()
    `);
    
    console.log('Result:', result);
}
```

### Example 5: Screenshot for Debugging

```typescript
async function debugWithScreenshot() {
    const safari = new SafariController();
    
    await safari.navigateTo('https://www.instagram.com/direct/inbox/');
    
    // Take screenshot
    const screenshotPath = await safari.takeScreenshot('debug_inbox.png');
    console.log('Screenshot saved:', screenshotPath);
    
    // Or get as base64 for API calls (e.g., vision AI)
    const base64 = await safari.getScreenshotBase64();
    // Use with OpenAI Vision, Google Vision, etc.
}
```

---

## Integration Patterns

### Pattern 1: Using as a Library

```typescript
// Install: npm install (from cloned repo)
// Or copy the relevant files to your project

import { SafariController } from 'riona/src/client/SafariController';
import { logger } from 'riona/src/utils/logger';

class MyAutomation {
    private safari: SafariController;
    
    constructor() {
        this.safari = new SafariController(60000);
    }
    
    async run() {
        // Your automation logic
    }
}
```

### Pattern 2: Extending SafariController

```typescript
import { SafariController, PageState } from './SafariController';

class TwitterSafariController extends SafariController {
    async navigateToTwitter(): Promise<boolean> {
        return this.navigateTo('https://twitter.com');
    }
    
    async getTweets(): Promise<any[]> {
        const jsCode = `
            (function() {
                const tweets = [];
                document.querySelectorAll('article[data-testid="tweet"]').forEach(t => {
                    tweets.push({
                        text: t.textContent,
                        // ... extract more data
                    });
                });
                return JSON.stringify(tweets);
            })()
        `;
        const result = await this.executeJS(jsCode);
        return JSON.parse(result);
    }
}
```

### Pattern 3: Multi-Browser Strategy

```typescript
import { launchBrowser, BrowserConfig } from './BrowserAdapter';
import { SafariController } from './SafariController';

async function multiPlatformAutomation() {
    // Use Safari for sites where you're logged in
    const safari = new SafariController();
    
    // Use Chrome/Puppeteer for headless scraping
    const chrome = await launchBrowser({
        browserType: 'chrome',
        headless: true
    });
    
    // Use appropriate browser for each task
    await safari.navigateTo('https://instagram.com');  // Uses session
    
    const page = await chrome.newPage();
    await page.goto('https://some-public-site.com');   // Headless OK
}
```

---

## Best Practices

### 1. Error Handling

```typescript
async function robustAutomation() {
    const safari = new SafariController();
    
    try {
        const success = await safari.navigateTo('https://instagram.com');
        if (!success) {
            logger.error('Navigation failed');
            return;
        }
        
        // Continue with automation
    } catch (error) {
        logger.error('Automation error:', error);
        
        // Take debug screenshot
        await safari.takeScreenshot('error_state.png');
    }
}
```

### 2. Rate Limiting

```typescript
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimitedActions() {
    const safari = new SafariController();
    const conversations = await safari.getConversations();
    
    for (const conv of conversations) {
        await safari.clickConversation(conv.index);
        
        // Wait between actions to avoid detection
        await delay(2000 + Math.random() * 2000);
        
        await safari.goBackToInbox();
        await delay(1500);
    }
}
```

### 3. Selector Strategies

Instagram's DOM changes frequently. Use multiple fallback strategies:

```typescript
const jsCode = `
(function() {
    // Strategy 1: Direct selector
    let element = document.querySelector('button[aria-label="Send"]');
    
    // Strategy 2: Text content
    if (!element) {
        const buttons = document.querySelectorAll('button');
        element = Array.from(buttons).find(b => 
            b.textContent.toLowerCase().includes('send')
        );
    }
    
    // Strategy 3: Parent-child relationship
    if (!element) {
        const form = document.querySelector('form');
        element = form?.querySelector('button[type="submit"]');
    }
    
    if (element) {
        element.click();
        return 'success';
    }
    return 'not_found';
})()
`;
```

### 4. Session Management

The Safari approach uses your existing session. To ensure persistence:

```typescript
// Check if logged in before operations
async function ensureLoggedIn(safari: SafariController): Promise<boolean> {
    await safari.navigateTo('https://www.instagram.com');
    await delay(3000);
    
    const state = await safari.getPageState();
    
    if (state.hasLoginForm) {
        logger.error('Not logged in - please log in manually in Safari');
        return false;
    }
    
    if (!state.loggedIn) {
        logger.warn('Login state unclear - proceeding with caution');
    }
    
    return true;
}
```

---

## Troubleshooting

### Common Issues

#### 1. "Not authorized to send Apple events"

**Solution**: Grant Terminal/IDE automation permissions:
- System Settings → Privacy & Security → Automation
- Enable access for Terminal, VS Code, or your IDE

#### 2. AppleScript timeout

**Solution**: Increase timeout in constructor:
```typescript
const safari = new SafariController(60000); // 60 seconds
```

#### 3. JavaScript execution returns empty

**Possible causes**:
- Page not fully loaded
- Safari Developer Menu not enabled
- Cross-origin restrictions

**Solutions**:
```typescript
// Wait for page load
await delay(3000);

// Check page state first
const state = await safari.getPageState();
console.log('Current URL:', state.url);

// Use try-catch in JS
const result = await safari.executeJS(`
    try {
        return document.title;
    } catch (e) {
        return 'Error: ' + e.message;
    }
`);
```

#### 4. Selectors not finding elements

Instagram's class names are obfuscated and change frequently. Use:
- Aria labels: `[aria-label="Like"]`
- Data attributes: `[data-testid="..."]`
- Structural queries: `article > div > div`
- Text content matching

#### 5. Safari window not found

```typescript
// Ensure Safari is running
await safari.launchSafari('about:blank');
await delay(1000);
// Then navigate
await safari.navigateTo('https://instagram.com');
```

### Debug Mode

Enable verbose logging:

```typescript
// In your code
import { logger } from './utils/logger';
logger.level = 'debug';

// Or via environment
// LOG_LEVEL=debug npm start
```

### Taking Debug Screenshots

```typescript
async function debugStep(safari: SafariController, step: string) {
    const filename = `debug_${step}_${Date.now()}.png`;
    await safari.takeScreenshot(filename);
    logger.debug(`Screenshot saved: ${filename}`);
}

// Usage
await debugStep(safari, 'before_click');
await safari.clickConversation(0);
await debugStep(safari, 'after_click');
```

---

## Additional Resources

- **Technical Documentation**: `docs/technical-docs/`
- **Instagram Selectors Reference**: `docs/instagram-selectors.md`
- **Setup Guide**: `docs/setup-guide.md`
- **Browser Automation Deep Dive**: `docs/technical-docs/04-browser-automation.md`

---

## License

MIT License - See LICENSE file for details.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

For questions or issues, please open a GitHub issue.
