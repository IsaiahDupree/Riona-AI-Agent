/**
 * Debug: Open Instagram inbox and screenshot + dump selectors for the compose button
 */
require('dotenv').config();

async function debug() {
    const { InstagramDM } = require('./build/client/Instagram-DM');
    const dm = new InstagramDM();

    try {
        await dm.initialize();
        const page = dm.page;

        // Navigate to inbox
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        // Screenshot
        await page.screenshot({ path: 'debug-ig-inbox.png', fullPage: false });
        console.log('Screenshot saved: debug-ig-inbox.png');

        // Dump all aria-labels
        const labels = await page.evaluate(() => {
            const els = document.querySelectorAll('[aria-label]');
            return Array.from(els).map(el => ({
                tag: el.tagName.toLowerCase(),
                label: el.getAttribute('aria-label'),
                role: el.getAttribute('role'),
                rect: el.getBoundingClientRect(),
            })).filter(e => e.rect.y < 250); // Top area only
        });

        console.log('\nAria-labels in top area:');
        for (const l of labels) {
            console.log(`  <${l.tag} aria-label="${l.label}" role="${l.role}"> y=${Math.round(l.rect.y)} h=${Math.round(l.rect.height)}`);
        }

        // Dump all SVGs with labels
        const svgs = await page.evaluate(() => {
            const els = document.querySelectorAll('svg[aria-label]');
            return Array.from(els).map(el => ({
                label: el.getAttribute('aria-label'),
                parent: el.parentElement?.tagName,
                parentRole: el.parentElement?.getAttribute('role'),
                rect: el.getBoundingClientRect(),
            }));
        });

        console.log('\nAll SVGs with aria-labels:');
        for (const s of svgs) {
            console.log(`  svg[aria-label="${s.label}"] parent=<${s.parent} role="${s.parentRole}"> y=${Math.round(s.rect.y)}`);
        }

        // Check for compose-like buttons
        const buttons = await page.evaluate(() => {
            const btns = document.querySelectorAll('div[role="button"], button');
            return Array.from(btns).map(el => {
                const rect = el.getBoundingClientRect();
                const svg = el.querySelector('svg');
                const text = el.textContent?.trim().slice(0, 40);
                return {
                    tag: el.tagName,
                    text,
                    hasSvg: !!svg,
                    svgLabel: svg?.getAttribute('aria-label'),
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                };
            }).filter(b => b.rect.y < 250 && b.rect.w < 150);
        });

        console.log('\nButtons in top area (w < 150):');
        for (const b of buttons) {
            console.log(`  <${b.tag}> "${b.text}" svg=${b.svgLabel || b.hasSvg} pos=(${b.rect.x},${b.rect.y}) size=${b.rect.w}x${b.rect.h}`);
        }

    } catch (err) {
        console.error('Debug failed:', err.message);
    } finally {
        await dm.close();
    }
}

debug().catch(console.error);
