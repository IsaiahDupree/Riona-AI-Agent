# AppleScript Safari Automation Reference

> **A standalone reference for controlling Safari via AppleScript from Node.js/TypeScript**

This document extracts the key AppleScript patterns from Riona for developers who want to implement Safari automation in their own projects.

---

## Quick Start

### Minimal Setup

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runAppleScript(script: string): Promise<string> {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, {
        timeout: 30000
    });
    return stdout.trim();
}
```

---

## Core AppleScript Commands

### 1. Launch Safari

```applescript
tell application "Safari"
    activate
    if (count of windows) = 0 then
        make new document with properties {URL:"https://example.com"}
    else
        tell front window
            set URL of current tab to "https://example.com"
        end tell
    end if
end tell
```

### 2. Navigate to URL

```applescript
tell application "Safari"
    activate
    tell front window
        set URL of current tab to "https://example.com"
    end tell
end tell
```

### 3. Get Current URL

```applescript
tell application "Safari"
    tell front window
        return URL of current tab
    end tell
end tell
```

### 4. Get Page Title

```applescript
tell application "Safari"
    tell front window
        return name of current tab
    end tell
end tell
```

### 5. Execute JavaScript

```applescript
tell application "Safari"
    tell front window
        tell current tab
            do JavaScript "document.title"
        end tell
    end tell
end tell
```

### 6. Get Page Source

```applescript
tell application "Safari"
    tell front window
        tell current tab
            do JavaScript "document.documentElement.outerHTML"
        end tell
    end tell
end tell
```

---

## TypeScript Implementation

### SafariController Class (Minimal)

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class SafariController {
    private timeout: number;

    constructor(timeout: number = 30000) {
        this.timeout = timeout;
    }

    private async runAppleScript(script: string): Promise<string> {
        try {
            const escapedScript = script.replace(/'/g, "'\"'\"'");
            const { stdout, stderr } = await execAsync(
                `osascript -e '${escapedScript}'`,
                { timeout: this.timeout }
            );
            return stdout.trim();
        } catch (error: any) {
            console.error('AppleScript error:', error.message);
            throw error;
        }
    }

    async executeJS(jsCode: string): Promise<string> {
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

        return this.runAppleScript(script);
    }

    async launch(url: string): Promise<boolean> {
        const script = `
tell application "Safari"
    activate
    if (count of windows) = 0 then
        make new document with properties {URL:"${url}"}
    else
        tell front window
            set URL of current tab to "${url}"
        end tell
    end if
end tell`;

        try {
            await this.runAppleScript(script);
            return true;
        } catch {
            return false;
        }
    }

    async navigateTo(url: string): Promise<boolean> {
        const script = `
tell application "Safari"
    activate
    tell front window
        set URL of current tab to "${url}"
    end tell
end tell`;

        try {
            await this.runAppleScript(script);
            return true;
        } catch {
            return false;
        }
    }

    async getCurrentUrl(): Promise<string> {
        const script = `
tell application "Safari"
    tell front window
        return URL of current tab
    end tell
end tell`;
        return this.runAppleScript(script);
    }

    async getTitle(): Promise<string> {
        const script = `
tell application "Safari"
    tell front window
        return name of current tab
    end tell
end tell`;
        return this.runAppleScript(script);
    }
}
```

---

## JavaScript Injection Patterns

### Pattern 1: Return Simple Value

```typescript
const title = await safari.executeJS('document.title');
```

### Pattern 2: Return JSON Object

```typescript
const pageInfo = await safari.executeJS(`
    JSON.stringify({
        url: window.location.href,
        title: document.title,
        links: document.querySelectorAll('a').length
    })
`);
const info = JSON.parse(pageInfo);
```

### Pattern 3: IIFE for Complex Logic

```typescript
const result = await safari.executeJS(`
    (function() {
        var elements = document.querySelectorAll('.item');
        var data = [];
        elements.forEach(function(el) {
            data.push({
                text: el.textContent,
                href: el.href || null
            });
        });
        return JSON.stringify(data);
    })()
`);
```

### Pattern 4: Click Element

```typescript
const clicked = await safari.executeJS(`
    (function() {
        var button = document.querySelector('button.submit');
        if (button) {
            button.click();
            return 'clicked';
        }
        return 'not_found';
    })()
`);
```

### Pattern 5: Fill Input Field

```typescript
async function fillInput(selector: string, value: string): Promise<boolean> {
    const escapedValue = value.replace(/"/g, '\\"');
    const result = await safari.executeJS(`
        (function() {
            var input = document.querySelector('${selector}');
            if (!input) return 'not_found';
            
            input.focus();
            input.value = "${escapedValue}";
            input.dispatchEvent(new Event('input', {bubbles: true}));
            input.dispatchEvent(new Event('change', {bubbles: true}));
            return 'filled';
        })()
    `);
    return result === 'filled';
}
```

### Pattern 6: Scroll Page

```typescript
async function scrollDown(pixels: number): Promise<void> {
    await safari.executeJS(`window.scrollBy(0, ${pixels})`);
}

async function scrollToElement(selector: string): Promise<boolean> {
    const result = await safari.executeJS(`
        (function() {
            var el = document.querySelector('${selector}');
            if (el) {
                el.scrollIntoView({behavior: 'smooth', block: 'center'});
                return 'scrolled';
            }
            return 'not_found';
        })()
    `);
    return result === 'scrolled';
}
```

### Pattern 7: Wait for Element

```typescript
async function waitForElement(
    safari: SafariController,
    selector: string,
    timeoutMs: number = 10000
): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        const found = await safari.executeJS(`
            document.querySelector('${selector}') !== null
        `);
        
        if (found === 'true') return true;
        
        await new Promise(r => setTimeout(r, 500));
    }
    
    return false;
}
```

---

## Screenshot Capture

### Using screencapture Command

```typescript
import * as fs from 'fs';
import * as path from 'path';

async function takeScreenshot(filename?: string): Promise<string> {
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshotName = filename || `safari_${Date.now()}.png`;
    const screenshotPath = path.join(screenshotDir, screenshotName);

    // Capture Safari window by ID
    const script = `
tell application "Safari"
    set winID to id of front window
end tell
do shell script "screencapture -l " & winID & " '${screenshotPath}'"
return "${screenshotPath}"
`;

    try {
        await runAppleScript(script);
        return screenshotPath;
    } catch (error) {
        // Fallback: capture entire screen
        await execAsync(`screencapture -x "${screenshotPath}"`);
        return screenshotPath;
    }
}
```

### Get Screenshot as Base64

```typescript
async function getScreenshotBase64(): Promise<string> {
    const filepath = await takeScreenshot();
    const buffer = fs.readFileSync(filepath);
    return buffer.toString('base64');
}
```

---

## Tab Management

### Open New Tab

```applescript
tell application "Safari"
    tell front window
        set newTab to make new tab with properties {URL:"https://example.com"}
        set current tab to newTab
    end tell
end tell
```

### Close Current Tab

```applescript
tell application "Safari"
    tell front window
        close current tab
    end tell
end tell
```

### Switch to Tab by Index

```applescript
tell application "Safari"
    tell front window
        set current tab to tab 2
    end tell
end tell
```

### Get All Tab URLs

```applescript
tell application "Safari"
    tell front window
        set tabUrls to {}
        repeat with t in tabs
            set end of tabUrls to URL of t
        end repeat
        return tabUrls
    end tell
end tell
```

---

## Window Management

### Bring Safari to Front

```applescript
tell application "Safari"
    activate
end tell
```

### Get Window Bounds

```applescript
tell application "Safari"
    tell front window
        return bounds
    end tell
end tell
```

### Set Window Size

```applescript
tell application "Safari"
    tell front window
        set bounds to {0, 0, 1920, 1080}
    end tell
end tell
```

---

## Common Selector Strategies

Modern web apps (like Instagram) use obfuscated class names. Use these strategies:

### 1. Aria Labels (Most Reliable)

```javascript
document.querySelector('[aria-label="Like"]')
document.querySelector('[aria-label*="Send"]')  // Contains
```

### 2. Data Attributes

```javascript
document.querySelector('[data-testid="tweet"]')
document.querySelector('[role="button"]')
```

### 3. Text Content Matching

```javascript
(function() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent.toLowerCase().includes('submit')) {
            return buttons[i];
        }
    }
    return null;
})()
```

### 4. Structural Queries

```javascript
document.querySelector('form > div > button[type="submit"]')
document.querySelector('article img[alt*="profile"]')
```

### 5. Multiple Fallback Strategies

```javascript
(function() {
    // Strategy 1
    var el = document.querySelector('[aria-label="Send"]');
    if (el) return el;
    
    // Strategy 2
    el = document.querySelector('button[type="submit"]');
    if (el) return el;
    
    // Strategy 3
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent === 'Send') return buttons[i];
    }
    
    return null;
})()
```

---

## Error Handling

### Robust AppleScript Execution

```typescript
async function runAppleScriptSafe(script: string): Promise<{
    success: boolean;
    result?: string;
    error?: string;
}> {
    try {
        const escapedScript = script.replace(/'/g, "'\"'\"'");
        const { stdout, stderr } = await execAsync(
            `osascript -e '${escapedScript}'`,
            { timeout: 30000 }
        );
        
        if (stderr && !stderr.includes('missing value')) {
            return { success: false, error: stderr };
        }
        
        return { success: true, result: stdout.trim() };
    } catch (error: any) {
        return { 
            success: false, 
            error: error.message || String(error)
        };
    }
}
```

### JavaScript Execution with Error Capture

```typescript
async function safeExecuteJS(jsCode: string): Promise<{
    success: boolean;
    result?: any;
    error?: string;
}> {
    const wrappedCode = `
        (function() {
            try {
                var result = (function() { ${jsCode} })();
                return JSON.stringify({success: true, result: result});
            } catch (e) {
                return JSON.stringify({success: false, error: e.message});
            }
        })()
    `;
    
    const response = await safari.executeJS(wrappedCode);
    return JSON.parse(response);
}
```

---

## Debugging Tips

### 1. Enable Safari Developer Menu

- Safari → Settings → Advanced → Show Develop menu in menu bar

### 2. Check Automation Permissions

- System Settings → Privacy & Security → Automation
- Ensure Terminal/IDE has Safari access

### 3. Test AppleScript Directly

```bash
osascript -e 'tell application "Safari" to return URL of current tab of front window'
```

### 4. Debug JavaScript in Web Inspector

1. Open Safari Developer Tools (Cmd+Option+I)
2. Test your JavaScript in the Console first
3. Then embed in AppleScript

### 5. Log Everything

```typescript
async function debugExecuteJS(jsCode: string): Promise<string> {
    console.log('Executing JS:', jsCode.substring(0, 100) + '...');
    const result = await safari.executeJS(jsCode);
    console.log('Result:', result.substring(0, 200));
    return result;
}
```

---

## Complete Example: Generic Page Scraper

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class SafariScraper {
    private timeout: number;

    constructor(timeout: number = 30000) {
        this.timeout = timeout;
    }

    private async runAppleScript(script: string): Promise<string> {
        const escapedScript = script.replace(/'/g, "'\"'\"'");
        const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, {
            timeout: this.timeout
        });
        return stdout.trim();
    }

    async executeJS(jsCode: string): Promise<string> {
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
        return this.runAppleScript(script);
    }

    async navigateTo(url: string): Promise<void> {
        const script = `
tell application "Safari"
    activate
    if (count of windows) = 0 then
        make new document with properties {URL:"${url}"}
    else
        tell front window
            set URL of current tab to "${url}"
        end tell
    end if
end tell`;
        await this.runAppleScript(script);
    }

    async waitForPageLoad(maxWait: number = 10000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const state = await this.executeJS('document.readyState');
            if (state === 'complete') return;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    async scrapeLinks(): Promise<Array<{text: string; href: string}>> {
        const result = await this.executeJS(`
            (function() {
                var links = [];
                document.querySelectorAll('a[href]').forEach(function(a) {
                    links.push({
                        text: a.textContent.trim().substring(0, 100),
                        href: a.href
                    });
                });
                return JSON.stringify(links);
            })()
        `);
        return JSON.parse(result);
    }

    async scrapeText(selector: string): Promise<string[]> {
        const result = await this.executeJS(`
            (function() {
                var texts = [];
                document.querySelectorAll('${selector}').forEach(function(el) {
                    texts.push(el.textContent.trim());
                });
                return JSON.stringify(texts);
            })()
        `);
        return JSON.parse(result);
    }
}

// Usage
async function main() {
    const scraper = new SafariScraper();
    
    await scraper.navigateTo('https://news.ycombinator.com');
    await scraper.waitForPageLoad();
    
    const headlines = await scraper.scrapeText('.titleline > a');
    console.log('Headlines:', headlines.slice(0, 5));
}

main().catch(console.error);
```

---

## Limitations

1. **macOS Only**: AppleScript is a macOS-specific technology
2. **Safari Must Be Running**: The browser needs to be open (visible or hidden)
3. **No Incognito Mode**: Uses your regular Safari profile
4. **Cross-Origin Restrictions**: JavaScript execution follows same-origin policy
5. **Rate Limits**: No built-in protection against rate limiting
6. **Dynamic Content**: May need delays for JavaScript-rendered content

---

## Resources

- [AppleScript Language Guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/)
- [Safari AppleScript Reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Conceptual/SafariAppleScriptRef/)
- [Node.js child_process](https://nodejs.org/api/child_process.html)

---

*This reference is extracted from the Riona Safari Automation project.*
