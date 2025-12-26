# Browser Automation

## Puppeteer Implementation

The Instagram bot uses Puppeteer for browser automation with sophisticated human-like interaction patterns.

### Browser Setup

```typescript
// Browser initialization with optimal settings
async function initializeBrowser(): Promise<{ browser: Browser; page: Page }> {
    const browser = await puppeteer.launch({
        headless: false, // Visual mode for monitoring
        defaultViewport: null, // Use default viewport
        args: [
            '--start-maximized', // Full screen
            '--disable-notifications', // Disable notifications
            '--disable-extensions', // Disable extensions
            '--no-sandbox', // Recommended for stability
            '--disable-setuid-sandbox'
        ]
    });

    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    // Enable stealth mode
    await page.evaluateOnNewDocument(() => {
        // Override navigator properties
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
    });

    return { browser, page };
}
```

## Selector Strategies

### Dynamic Selector Management

```typescript
// Selector configuration for different Instagram elements
const SELECTORS = {
    POST: {
        CONTAINER: 'article[role="presentation"]',
        LIKE_BUTTON: 'svg[aria-label="Like"]',
        COMMENT_BOX: 'textarea[aria-label="Add a comment…"]',
        SUBMIT_BUTTON: 'button[type="submit"]',
        CAPTION: 'div[role="menuitem"] span',
        USERNAME: 'a[role="link"]',
        TIMESTAMP: 'time'
    },
    NAVIGATION: {
        NEXT_BUTTON: 'button[aria-label="Next"]',
        PREVIOUS_BUTTON: 'button[aria-label="Previous"]',
        HOME: 'a[href="/"]'
    }
};

// Selector retry mechanism
async function findElementWithRetry(
    page: Page,
    selector: string,
    options: {
        timeout?: number;
        retries?: number;
        delay?: number;
    } = {}
): Promise<ElementHandle<Element> | null> {
    const { timeout = 5000, retries = 3, delay = 1000 } = options;
    
    for (let i = 0; i < retries; i++) {
        try {
            const element = await page.waitForSelector(selector, {
                timeout,
                visible: true
            });
            return element;
        } catch (error) {
            if (i === retries - 1) return null;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return null;
}
```

## Human-like Interaction

### Mouse Movement Simulation

```typescript
// Simulate natural mouse movement
async function moveMouseNaturally(
    page: Page,
    target: ElementHandle<Element>
): Promise<void> {
    const box = await target.boundingBox();
    if (!box) return;

    const { x, y, width, height } = box;
    const points = generateBezierCurve(
        page.mouse.position(),
        {
            x: x + width / 2,
            y: y + height / 2
        }
    );

    for (const point of points) {
        await page.mouse.move(
            point.x,
            point.y,
            { steps: 1 }
        );
        await delay(Math.random() * 10);
    }
}

// Generate natural curve for mouse movement
function generateBezierCurve(
    start: { x: number; y: number },
    end: { x: number; y: number }
): Array<{ x: number; y: number }> {
    const controlPoint1 = {
        x: start.x + (Math.random() * 100 - 50),
        y: start.y + (Math.random() * 100 - 50)
    };
    const controlPoint2 = {
        x: end.x + (Math.random() * 100 - 50),
        y: end.y + (Math.random() * 100 - 50)
    };

    const points: Array<{ x: number; y: number }> = [];
    for (let t = 0; t <= 1; t += 0.01) {
        points.push(bezierPoint(start, controlPoint1, controlPoint2, end, t));
    }
    return points;
}
```

### Keyboard Input Simulation

```typescript
// Simulate natural typing
async function typeNaturally(
    page: Page,
    element: ElementHandle<Element>,
    text: string
): Promise<void> {
    await element.focus();
    
    for (const char of text) {
        // Random delay between keystrokes
        const delay = Math.random() * 100 + 30;
        await page.keyboard.type(char, { delay });
        
        // Occasional longer pauses
        if (Math.random() < 0.1) {
            await new Promise(r => setTimeout(r, Math.random() * 500 + 100));
        }
    }
}
```

### Scroll Behavior

```typescript
// Natural scrolling implementation
async function scrollNaturally(
    page: Page,
    distance: number,
    options: {
        speed?: number;
        smoothness?: number;
    } = {}
): Promise<void> {
    const { speed = 1, smoothness = 100 } = options;
    const steps = Math.abs(Math.floor(distance / smoothness));
    const stepSize = distance / steps;
    
    for (let i = 0; i < steps; i++) {
        await page.evaluate((step) => {
            window.scrollBy(0, step);
        }, stepSize);
        
        // Random delay between scroll steps
        await delay(Math.random() * 10 * speed);
    }
}
```

## Element Interaction

### Click Implementation

```typescript
// Precise click with natural behavior
async function clickWithPrecision(
    page: Page,
    element: ElementHandle<Element>
): Promise<boolean> {
    try {
        const box = await element.boundingBox();
        if (!box) return false;

        // Move to element naturally
        await moveMouseNaturally(page, element);

        // Add slight random offset within element bounds
        const clickX = box.x + box.width / 2 + (Math.random() * 4 - 2);
        const clickY = box.y + box.height / 2 + (Math.random() * 4 - 2);

        // Perform click with random delay
        await delay(Math.random() * 200 + 100);
        await page.mouse.click(clickX, clickY);

        return true;
    } catch (error) {
        logger.error('Error during precise click:', error);
        return false;
    }
}
```

### Element Visibility Checking

```typescript
// Check if element is truly visible and interactive
async function isElementVisible(
    element: ElementHandle<Element>
): Promise<boolean> {
    try {
        const isVisible = await element.evaluate((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   rect.width > 0 &&
                   rect.height > 0;
        });

        return isVisible;
    } catch (error) {
        return false;
    }
}
```

## Error Recovery

### Page State Recovery

```typescript
// Recover from common page state issues
async function recoverPageState(
    page: Page,
    context: string
): Promise<boolean> {
    try {
        // Check for common error states
        const errorStates = [
            { selector: 'div[role="alert"]', action: 'dismiss' },
            { selector: 'div[role="dialog"]', action: 'close' },
            { selector: '.error-page', action: 'reload' }
        ];

        for (const state of errorStates) {
            const element = await page.$(state.selector);
            if (element) {
                switch (state.action) {
                    case 'dismiss':
                        await element.click();
                        break;
                    case 'close':
                        await page.keyboard.press('Escape');
                        break;
                    case 'reload':
                        await page.reload();
                        break;
                }
                await delay(2000);
            }
        }

        return true;
    } catch (error) {
        logger.error('Error during page state recovery:', {
            error,
            context
        });
        return false;
    }
}
```
