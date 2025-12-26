/**
 * Utility functions for adding jitter and human-like behavior to Instagram interactions
 */

/**
 * Adds random jitter to a base value
 * @param {number} baseValue - The base value to add jitter to
 * @param {number} jitterPercent - The percentage of jitter to add (0.1 = 10%)
 * @returns {number} The base value with jitter applied
 */
function randomJitter(baseValue, jitterPercent = 0.1) {
    const jitterRange = baseValue * jitterPercent;
    return Math.floor(baseValue + (Math.random() * 2 - 1) * jitterRange);
}

/**
 * Creates a random delay within a range to simulate human behavior
 * @param {number} min - Minimum delay in milliseconds
 * @param {number} max - Maximum delay in milliseconds
 * @returns {number} A random delay between min and max
 */
function humanLikeDelay(min, max) {
    return min + Math.random() * (max - min);
}

/**
 * Delays execution for a specified number of milliseconds
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>} A promise that resolves after the delay
 */
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Types text into an input field with random timing to mimic human typing
 * @param {Page} page - Puppeteer page object
 * @param {string} selector - CSS selector for the input field
 * @param {string} text - Text to type
 */
async function humanTyping(page, selector, text) {
    await page.focus(selector);
    
    // Clear any existing text
    await page.evaluate(selector => {
        document.querySelector(selector).value = "";
    }, selector);
    
    // Type with variable speed like a human
    for (let i = 0; i < text.length; i++) {
        const char = text.charAt(i);
        await page.type(selector, char, { delay: randomJitter(100, 0.5) });
        
        // Occasionally pause like a human would
        if (Math.random() < 0.1) {
            await delay(humanLikeDelay(200, 600));
        }
    }
}

/**
 * Moves the mouse to a target element in a natural, human-like way
 * @param {Page} page - Puppeteer page object
 * @param {string} selector - CSS selector for the target element
 */
async function naturalMouseMovement(page, selector) {
    try {
        // Get element position and dimensions
        const elementHandle = await page.$(selector);
        if (!elementHandle) {
            console.log(`Element with selector ${selector} not found for mouse movement`);
            return;
        }
        
        const box = await elementHandle.boundingBox();
        if (!box) {
            console.log(`Could not get bounding box for ${selector}`);
            return;
        }
        
        // Calculate target point with some randomness (not exactly the center)
        const targetX = box.x + box.width * (0.4 + Math.random() * 0.2);
        const targetY = box.y + box.height * (0.4 + Math.random() * 0.2);
        
        // Get current mouse position or assume center of screen
        const currentPosition = await page.evaluate(() => {
            return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        });
        
        // Generate intermediate points for natural curve movement
        const numSteps = randomJitter(10, 0.3);
        const points = [];
        
        // Create slightly curved path
        for (let i = 0; i <= numSteps; i++) {
            const ratio = i / numSteps;
            
            // Add slight curve using sine function
            const deviation = Math.sin(ratio * Math.PI) * (Math.random() * 20 + 5);
            const deviationX = deviation * (Math.random() > 0.5 ? 1 : -1);
            const deviationY = deviation * (Math.random() > 0.5 ? 1 : -1);
            
            const x = currentPosition.x + (targetX - currentPosition.x) * ratio + deviationX;
            const y = currentPosition.y + (targetY - currentPosition.y) * ratio + deviationY;
            
            points.push({ x, y });
        }
        
        // Ensure final point is exact target
        points[points.length - 1] = { x: targetX, y: targetY };
        
        // Move the mouse along the path with variable speed
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const speedFactor = 1 - Math.sin(i / points.length * Math.PI) * 0.5;
            await page.mouse.move(point.x, point.y, { steps: randomJitter(5, 0.3) });
            await delay(humanLikeDelay(10, 20) * speedFactor);
        }
        
        // Slight pause before clicking, like a human
        await delay(humanLikeDelay(100, 300));
        
        // Click with variable delay
        await page.mouse.down();
        await delay(humanLikeDelay(20, 100));
        await page.mouse.up();
        
        console.log(`Successfully clicked on ${selector} with natural movement`);
    } catch (error) {
        console.error('Error during natural mouse movement:', error);
        // Fallback to direct click if movement fails
        await page.click(selector);
    }
}

/**
 * Scrolls the page in a natural, human-like way
 * @param {Page} page - Puppeteer page object
 * @param {number} distance - Distance to scroll
 */
async function naturalScroll(page, distance) {
    // Break scrolling into multiple smaller movements
    const scrollSegments = 5 + Math.floor(Math.random() * 5);
    const baseScrollAmount = distance / scrollSegments;
    
    for (let i = 0; i < scrollSegments; i++) {
        // Add some randomness to each scroll segment
        const scrollAmount = randomJitter(baseScrollAmount, 0.3);
        
        await page.evaluate((scrollY) => {
            window.scrollBy(0, scrollY);
        }, scrollAmount);
        
        // Variable pause between scrolls
        await delay(humanLikeDelay(50, 200));
        
        // Occasionally pause during scrolling (like a human reading)
        if (Math.random() < 0.2) {
            await delay(humanLikeDelay(400, 1200));
        }
    }
}

module.exports = {
    randomJitter,
    humanLikeDelay,
    delay,
    humanTyping,
    naturalMouseMovement,
    naturalScroll
};
