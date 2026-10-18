// Test script for Instagram connection issues
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Simple logging
function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
  
  // Also append to a log file
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(__dirname, 'connection-test.log'), logMessage);
}

// Utility function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Connection test function
async function testInstagramConnection() {
  log('Starting Instagram connection test');
  log(`Using proxy: ${process.env.INSTAGRAM_USE_PROXY === 'true' ? 'Yes' : 'No'}`);
  
  // Check internet connectivity first
  try {
    log('Testing general internet connectivity...');
    execSync('ping -n 2 google.com');
    log('Internet connectivity test passed');
  } catch (err) {
    log('WARNING: Internet connectivity test failed. Check your connection!');
  }
  
  let browser = null;
  
  try {
    log('Launching browser...');
    
    // Launch browser with improved settings
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--window-size=1280,720',
      '--start-maximized',
      '--disable-notifications',
      '--ignore-certificate-errors',
      '--lang=en-US,en'
    ];
    
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: launchArgs,
      ignoreHTTPSErrors: true
    });
    
    const page = await browser.newPage();
    
    // Set random user agent and headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0'
    });
    
    // Add page error and console log handlers
    page.on('error', err => log(`Page error: ${err.message}`));
    page.on('console', msg => log(`Browser console: ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', err => log(`Page JavaScript error: ${err.message}`));
    
    // Monitor network requests and responses
    page.on('request', request => {
      if (request.resourceType() === 'document') {
        log(`Request: ${request.method()} ${request.url()}`);
      }
    });
    
    page.on('response', response => {
      if (response.request().resourceType() === 'document') {
        log(`Response ${response.status()} for ${response.url()}`);
      }
    });
    
    // Try different test URLs to check connection
    const testUrls = [
      { url: 'https://httpbin.org/get', name: 'HttpBin' },
      { url: 'https://www.google.com/', name: 'Google' },
      { url: 'https://www.instagram.com/robots.txt', name: 'Instagram robots.txt' },
      { url: 'https://www.instagram.com/', name: 'Instagram homepage' },
      { url: 'https://www.instagram.com/accounts/login/', name: 'Instagram login page' }
    ];
    
    // Test each URL with different navigation strategies
    for (const site of testUrls) {
      log(`Testing connection to ${site.name} (${site.url})...`);
      
      // Try different navigation strategies
      const strategies = [
        { name: 'domcontentloaded (15s)', options: { waitUntil: 'domcontentloaded', timeout: 15000 } },
        { name: 'load (30s)', options: { waitUntil: 'load', timeout: 30000 } }
      ];
      
      let success = false;
      
      for (const strategy of strategies) {
        if (success) break;
        
        try {
          log(`  Using navigation strategy: ${strategy.name}`);
          
          // Clear cookies before each attempt
          const client = await page.target().createCDPSession();
          await client.send('Network.clearBrowserCookies');
          await client.send('Network.clearBrowserCache');
          
          const startTime = Date.now();
          await page.goto(site.url, strategy.options);
          const loadTime = Date.now() - startTime;
          
          log(`  ✅ Success! Page loaded in ${loadTime}ms`);
          
          // Take a screenshot to verify content
          const screenshotPath = path.join(__dirname, `${site.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          log(`  Screenshot saved to ${screenshotPath}`);
          
          // Verify content
          const pageTitle = await page.title();
          const pageContent = await page.content();
          log(`  Page title: ${pageTitle}`);
          log(`  Page content length: ${pageContent.length} bytes`);
          
          success = true;
          await delay(1000);
        } catch (error) {
          log(`  ❌ Error: ${error.message}`);
          
          // Analyze the error
          if (error.message.includes('ERR_EMPTY_RESPONSE')) {
            log('  ⚠️ DETECTED EMPTY RESPONSE ERROR - This indicates possible IP blocking or network issues');
          } else if (error.message.includes('ERR_CONNECTION_REFUSED')) {
            log('  ⚠️ CONNECTION REFUSED - Server is actively rejecting the connection');
          } else if (error.message.includes('Navigation timeout')) {
            log('  ⚠️ TIMEOUT - Page took too long to load or is blocking the request');
          }
          
          // Wait before trying next strategy
          await delay(2000);
        }
      }
      
      if (!success) {
        log(`❌ All strategies failed for ${site.name}`);
      }
      
      // Wait between sites to avoid rate limiting
      await delay(3000);
    }
    
    log('Connection test completed');
    
  } catch (error) {
    log(`Critical error: ${error.message}`);
    if (error.stack) {
      log(`Stack trace: ${error.stack}`);
    }
  } finally {
    // Cleanup
    if (browser) {
      log('Closing browser...');
      await browser.close();
    }
    log('Test finished');
  }
}

// Run the test
(async () => {
  try {
    await testInstagramConnection();
  } catch (err) {
    log(`Uncaught error: ${err.message}`);
    log(`Stack: ${err.stack}`);
  }
})();
