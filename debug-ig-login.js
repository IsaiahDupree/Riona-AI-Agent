/**
 * Debug: Force fresh Instagram login, save cookies, then screenshot inbox
 */
require('dotenv').config();

async function debug() {
    const { InstagramDM } = require('./build/client/Instagram-DM');
    const dm = new InstagramDM();

    try {
        console.log('Initializing (will force fresh login since cookies deleted)...');
        console.log('Username:', process.env.INSTAGRAM_BOT_USERNAME);
        console.log('Password:', process.env.INSTAGRAM_BOT_PASSWORD ? '***set***' : 'MISSING');

        await dm.initialize();
        const page = dm.page;

        console.log('Login complete. Taking screenshot of home page...');
        await page.screenshot({ path: 'debug-ig-home.png', fullPage: false });

        // Navigate to inbox
        console.log('Navigating to inbox...');
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        await page.screenshot({ path: 'debug-ig-inbox2.png', fullPage: false });
        console.log('Screenshots saved: debug-ig-home.png, debug-ig-inbox2.png');

        // Check current URL
        console.log('Current URL:', page.url());

        // Check for compose button
        const labels = await page.evaluate(() => {
            const els = document.querySelectorAll('[aria-label]');
            return Array.from(els).map(el => ({
                tag: el.tagName.toLowerCase(),
                label: el.getAttribute('aria-label'),
                role: el.getAttribute('role'),
                y: Math.round(el.getBoundingClientRect().y),
            }));
        });
        console.log('\nAll aria-labels on page:');
        for (const l of labels) {
            console.log(`  <${l.tag} aria-label="${l.label}" role="${l.role}"> y=${l.y}`);
        }

    } catch (err) {
        console.error('Failed:', err.message);
        console.error(err.stack);
    } finally {
        await dm.close();
    }
}

debug().catch(console.error);
