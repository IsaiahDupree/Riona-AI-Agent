import { InstagramDM } from './src/client/Instagram-DM';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
    const dm = new InstagramDM();
    try {
        await dm.initialize();
        const page = dm.getPage()!;

        await page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'domcontentloaded', timeout: 60000
        });
        await delay(5000);

        await page.screenshot({ path: '/tmp/dm-inbox-full.png', fullPage: false });
        console.log('[test] Screenshot saved');

        // Debug: dump all elements that could be conversations
        const debug = await page.evaluate(() => {
            const results: any = {};

            // Check what links exist
            const allLinks = document.querySelectorAll('a[href*="/direct/"]');
            results.directLinks = Array.from(allLinks).map(a => ({
                href: (a as HTMLAnchorElement).href,
                text: (a as HTMLElement).innerText?.slice(0, 50)
            })).slice(0, 10);

            // Check listitem/row roles
            results.listItems = document.querySelectorAll('div[role="listitem"]').length;
            results.rows = document.querySelectorAll('div[role="row"]').length;
            results.listboxes = document.querySelectorAll('div[role="listbox"]').length;
            results.lists = document.querySelectorAll('div[role="list"]').length;
            results.grids = document.querySelectorAll('div[role="grid"]').length;
            results.gridcells = document.querySelectorAll('div[role="gridcell"]').length;

            // Check for any elements containing conversation-like content
            const spans = document.querySelectorAll('span[dir="auto"]');
            results.spanTexts = Array.from(spans).map(s => s.textContent?.slice(0, 40)).slice(0, 20);

            // Check main content area
            const main = document.querySelector('main');
            results.mainExists = !!main;
            results.mainText = main?.innerText?.slice(0, 200);

            return results;
        });

        console.log('[test] DOM debug:', JSON.stringify(debug, null, 2));
    } catch (e: any) {
        console.error('[test] FATAL:', e.message);
    } finally {
        await dm.close();
        process.exit(0);
    }
})();
