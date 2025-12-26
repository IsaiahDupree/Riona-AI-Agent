import puppeteer from 'puppeteer';

describe('System / E2E Tests', () => {
    let browser: any;
    let page: any;

    beforeAll(async () => {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        page = await browser.newPage();
    });

    afterAll(async () => {
        if (browser) {
            await browser.close();
        }
    });

    it('should load Instagram login page', async () => {
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle0' });
        const title = await page.title();
        expect(title).toContain('Instagram');
    }, 60000); // Increased timeout for network

    it('should have username and password inputs', async () => {
        const usernameInput = await page.$('input[name="username"]');
        const passwordInput = await page.$('input[name="password"]');
        expect(usernameInput).toBeTruthy();
        expect(passwordInput).toBeTruthy();
    });
});
