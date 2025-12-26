/**
 * Threads Agent
 * 
 * This module provides automation functionalities tailored for threads.net.
 * It mirrors the features provided for Instagram automation, such as login, posting updates,
 * liking posts, and commenting, adapted for the Threads platform.
 * 
 * This is a work in progress. You may need to integrate this module with the rest of the system
 * and update the methods to interface with Threads appropriately.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const { Server } = require('proxy-chain');
const { loadCookies, saveCookies } = require('./utils');
const logger = require('./config/logger').default;
const dotenv = require('dotenv');
const path = require('path');
const OpenAI = require('openai');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({
    interceptResolutionPriority: 1
}));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ThreadsAgent {
    constructor(options = {}) {
        this.options = options;
        this.browser = null;
        this.page = null;
        this.proxyServer = null;
        
        // Validate required environment variables
        const requiredEnvVars = ['THREADS_USERNAME_1', 'THREADS_PASSWORD_1'];
        const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingEnvVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
        }

        // Store credentials
        this.username = process.env.THREADS_USERNAME_1;
        this.password = process.env.THREADS_PASSWORD_1;
    }

    async initialize() {
        try {
            // Start proxy server with a higher port
            const proxyPort = process.env.PROXY_PORT_2 || '9001';
            this.proxyServer = new Server({ port: parseInt(proxyPort) });
            
            try {
                await this.proxyServer.listen();
                logger.info(`Proxy server started on port ${proxyPort}`);
            } catch (error) {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`Port ${proxyPort} is already in use. Please try a different port.`);
                    return;
                }
                throw error;
            }
            
            const proxyUrl = `http://localhost:${proxyPort}`;

            const args = [
                `--proxy-server=${proxyUrl}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--remote-debugging-port=9222',  // Add debugging port
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ];

            this.browser = await puppeteer.launch({
                headless: false,
                args: args,
                defaultViewport: null
            });

            this.page = await this.browser.newPage();
            await this.login();
            
            logger.info('ThreadsAgent initialized successfully');
        } catch (error) {
            logger.error('Error initializing ThreadsAgent:', error);
            await this.cleanup();
            throw error;
        }
    }

    async login() {
        try {
            logger.info('Starting login process...');
            
            // Always proceed with credential login
            await this.loginWithCredentials();
            
            return true;
        } catch (error) {
            logger.error('Error during Threads login:', error);
            throw error;
        }
    }

    async verifyLogin() {
        try {
            logger.info('Verifying login by attempting to create a thread...');
            
            // Go to Threads home
            await this.page.goto('https://www.threads.net', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // Wait for the page to load
            await delay(5000);

            // Look for the new thread button
            const newThreadButton = await this.page.$('div[role="button"]');
            if (!newThreadButton) {
                logger.info('Could not find new thread button');
                return false;
            }

            // Click the new thread button
            await newThreadButton.click();
            await delay(2000);

            // Look for the thread composer
            const threadComposer = await this.page.$('div[role="textbox"]');
            if (!threadComposer) {
                logger.info('Could not find thread composer');
                return false;
            }

            // Save cookies after successful verification
            const cookies = await this.page.cookies();
            const cookiesPath = path.join(process.cwd(), 'cookies', `Threads_${this.username}_cookies.json`);
            await saveCookies(cookiesPath, cookies);
            logger.info('Saved cookies after successful login verification');

            logger.info('Successfully verified login - found thread composer');
            return true;
        } catch (error) {
            logger.warn('Error verifying login:', error);
            return false;
        }
    }

    async loginWithCredentials() {
        try {
            logger.info('Attempting to log in with credentials...');
            
            // Go directly to Threads login
            await this.page.goto("https://threads.net/login", { 
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            logger.info('Waiting for login form...');

            // Wait for the login form to appear
            await this.page.waitForSelector('input[type="text"], input[name="username"]', { timeout: 30000 });
            await delay(3000);

            // Fill login form using stored credentials
            await this.page.type('input[type="text"], input[name="username"]', this.username, { delay: 100 });
            await this.page.type('input[type="password"], input[name="password"]', this.password, { delay: 100 });
            
            logger.info('Attempting to submit login form...');

            // Click login button and wait for navigation
            const submitButton = await this.page.$('button[type="submit"]');
            if (submitButton) {
                await submitButton.click();
            } else {
                // Try pressing Enter if button not found
                await this.page.keyboard.press('Enter');
            }

            // Wait longer for the login process to complete
            await delay(15000);

            // Verify we're actually logged in by trying to create a thread
            const isLoggedIn = await this.verifyLogin();
            if (!isLoggedIn) {
                throw new Error('Login verification failed - could not access thread composer');
            }
            
            logger.info('Successfully logged in to Threads with credentials');
        } catch (error) {
            logger.error('Error logging in to Threads with credentials:', error);
            throw error;
        }
    }

    async post(content) {
        try {
            await this.page.goto('https://www.threads.net/', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            // Wait for new thread button
            await this.page.waitForSelector('button[aria-label="Create new thread"]', { timeout: 10000 });
            await this.page.click('button[aria-label="Create new thread"]');

            // Wait for text input and type content
            await this.page.waitForSelector('div[role="textbox"]', { timeout: 10000 });
            await this.page.type('div[role="textbox"]', content);

            // Wait for and click post button
            await this.page.waitForSelector('button[type="submit"]', { timeout: 10000 });
            await this.page.click('button[type="submit"]');
            
            // Wait for post to complete
            await delay(3000);
            
            logger.info('Successfully posted new thread');
            return { success: true };
        } catch (error) {
            logger.error('Error posting to Threads:', error);
            return { success: false, error: error.message };
        }
    }

    async like(postUrl) {
        try {
            await this.page.goto(postUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            // Wait for and click like button
            await this.page.waitForSelector('button[aria-label="Like"]', { timeout: 10000 });
            await this.page.click('button[aria-label="Like"]');
            
            // Wait for like to register
            await delay(2000);
            
            logger.info('Successfully liked thread');
            return { success: true };
        } catch (error) {
            logger.error('Error liking thread:', error);
            return { success: false, error: error.message };
        }
    }

    async comment(postUrl, commentText) {
        try {
            await this.page.goto(postUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            // Wait for and click reply button
            await this.page.waitForSelector('button[aria-label="Reply"]', { timeout: 10000 });
            await this.page.click('button[aria-label="Reply"]');

            // Wait for and fill comment box
            await this.page.waitForSelector('div[role="textbox"]', { timeout: 10000 });
            await this.page.type('div[role="textbox"]', commentText);

            // Wait for and click submit button
            await this.page.waitForSelector('button[type="submit"]', { timeout: 10000 });
            await this.page.click('button[type="submit"]');
            
            // Wait for comment to post
            await delay(3000);
            
            logger.info('Successfully commented on thread');
            return { success: true };
        } catch (error) {
            logger.error('Error commenting on thread:', error);
            return { success: false, error: error.message };
        }
    }

    async findPosts(username) {
        try {
            logger.info(`Finding posts for user: ${username}`);
            
            // Navigate to user's profile
            await this.page.goto(`https://www.threads.net/@${username}`, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            // Wait for posts to load
            await delay(5000);
            
            // Find all post containers
            const posts = await this.page.$$('article[role="article"]');
            logger.info(`Found ${posts.length} posts`);
            
            return posts;
        } catch (error) {
            logger.error('Error finding posts:', error);
            throw error;
        }
    }

    async likePost(post) {
        try {
            // Find the like button container
            const likeButton = await post.$('div[class*="x78zum5"] div[role="button"]:has(svg[aria-label="Like"])');
            if (!likeButton) {
                logger.warn('Like button not found');
                return false;
            }

            // Click the like button
            await likeButton.click();
            await delay(2000);
            logger.info('Post liked successfully');
            return true;
        } catch (error) {
            logger.error('Error liking post:', error);
            return false;
        }
    }

    async commentOnPost(post, retryCount = 2) {
        try {
            // Ensure post is in viewport and wait for it to be stable
            await post.evaluate(el => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            await delay(2000);

            let commentText;
            
            // Get post text and generate AI response
            const postText = await this.getPostText(post);
            if (postText) {
                const aiResponse = await this.generateAIResponse(postText);
                if (aiResponse) {
                    commentText = aiResponse;
                }
            }

            // Fall back to random comment if no AI response
            if (!commentText) {
                const fallbackComments = [
                    "Interesting point! 💡",
                    "Great insight! 🤔",
                    "Thanks for sharing! ✨",
                    "Love this perspective! 💭",
                    "Well said! 👏"
                ];
                commentText = fallbackComments[Math.floor(Math.random() * fallbackComments.length)];
            }

            // Immediately use the browser-use helper after generating the comment
            logger.info('Using browser-use helper for commenting...');
            await this.useBrowserUseHelper(commentText);

        } catch (error) {
            logger.error('Error in comment process:', error);
            return false;
        }
    }

    async getPostText(post) {
        try {
            // First try to get text content from the post
            const postText = await post.evaluate((el) => {
                // Look for text content in the specific span element used by Threads
                const textSpan = el.querySelector('span[class*="x1lliihq"][class*="x1plvlek"][dir="auto"]');
                if (textSpan) {
                    return textSpan.textContent.trim();
                }

                // Fallback: Look for any text content in common post containers
                const textContainers = el.querySelectorAll('div[dir="auto"], span[dir="auto"]');
                for (const container of textContainers) {
                    const text = container.textContent.trim();
                    if (text && text.length > 0) {
                        return text;
                    }
                }
                return '';
            });

            logger.info('Extracted post text:', postText);
            return postText;
        } catch (error) {
            logger.error('Error getting post text:', error);
            return '';
        }
    }

    async generateAIResponse(postText) {
        try {
            if (!postText) {
                return null;
            }

            const prompt = `Write a brief, tasteful response to this post. Keep it under 100 characters, natural, and engaging. Include one emoji if appropriate. Avoid hashtags, quotes, or special characters.

Post content: ${postText}

Write a concise response:`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are a thoughtful social media user who crafts brief, super meaningful responses. Keep replies concise and natural. Use emojis sparingly. Avoid generic responses, hashtags, and special characters or hashtags. Focus on quality over quantity."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 50,
                temperature: 0.7,
                presence_penalty: 0.6,
                frequency_penalty: 0.8
            });

            const aiResponse = response.choices[0].message.content.trim();
            
            // Clean the response of any unwanted characters
            const cleanedResponse = aiResponse
                .replace(/["*`#]/g, '') // Remove quotes, asterisks, hashtags, and backticks
                .trim();
            
            // Validate response length
            if (cleanedResponse.length > 100) {
                logger.warn('AI response too long, truncating...');
                return cleanedResponse.substring(0, 97) + '...';
            }

            logger.info('Generated AI response:', cleanedResponse);
            return cleanedResponse;
        } catch (error) {
            logger.error('Error generating AI response:', error);
            return null;
        }
    }

    async findPostsInFeed() {
        try {
            logger.info('Finding posts in main feed...');
            
            // Go to main feed and ensure it's loaded
            await this.page.goto('https://www.threads.net', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            // Wait for feed to load and find posts
            await this.page.waitForSelector('div[class*="x1n2onr6"] div[class*="x78zum5"] div[class*="x1n2onr6"]', {
                timeout: 30000
            });
            
            // Scroll a bit to load more posts
            await this.page.evaluate(() => {
                window.scrollBy(0, 500);
            });
            await delay(3000);
            
            // Find all post containers and validate them
            const posts = await this.page.$$('div[class*="x1ypdohk"][class*="x1n2onr6"]');
            
            // Filter out invalid posts
            const validPosts = [];
            for (const post of posts) {
                const hasLikeButton = await post.$('div[role="button"]:has(svg[aria-label="Like"])');
                const hasReplyButton = await post.$('div[role="button"]:has(svg[aria-label="Reply"])');
                if (hasLikeButton && hasReplyButton) {
                    validPosts.push(post);
                }
            }
            
            logger.info(`Found ${validPosts.length} valid posts in feed`);
            return validPosts;
        } catch (error) {
            logger.error('Error finding posts in feed:', error);
            throw error;
        }
    }

    async likePost(post, retryCount = 2) {
        for (let attempt = 0; attempt <= retryCount; attempt++) {
            try {
                // Ensure post is in viewport
                await post.evaluate(el => {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                await delay(1000);

                // Find and validate the like button
                const likeButton = await post.$('div[class*="x78zum5"] div[role="button"]:has(svg[aria-label="Like"])');
                if (!likeButton) {
                    logger.warn('Like button not found');
                    if (attempt === retryCount) return false;
                    continue;
                }

                // Check if already liked
                const isLiked = await post.$('div[role="button"]:has(svg[aria-label="Unlike"])');
                if (isLiked) {
                    logger.info('Post is already liked');
                    return true;
                }

                // Click the like button
                await likeButton.click();
                await delay(2000);

                // Verify the like was successful
                const likeVerified = await post.$('div[role="button"]:has(svg[aria-label="Unlike"])');
                if (likeVerified) {
                    logger.info('Post liked successfully');
                    return true;
                }

                if (attempt === retryCount) {
                    logger.warn('Could not verify like was successful');
                    return false;
                }
            } catch (error) {
                logger.error(`Error liking post (attempt ${attempt + 1}/${retryCount + 1}):`, error);
                if (attempt === retryCount) return false;
            }
            await delay(2000);
        }
        return false;
    }

    async interactWithFeedPosts(numPosts = 2) {
        try {
            const posts = await this.findPostsInFeed();
            if (posts.length === 0) {
                logger.warn('No valid posts found in feed');
                return false;
            }
            
            // Limit to specified number of posts
            const postsToInteract = posts.slice(0, numPosts);
            let successfulInteractions = 0;
            
            for (let i = 0; i < postsToInteract.length; i++) {
                const post = postsToInteract[i];
                logger.info(`Interacting with post ${i + 1}/${postsToInteract.length}`);
                
                // Like the post
                const likeSuccess = await this.likePost(post);
                if (likeSuccess) {
                    await delay(2000);
                    
                    // Only comment if like was successful
                    const commentSuccess = await this.commentOnPost(post);
                    if (commentSuccess) {
                        successfulInteractions++;
                    }
                }
                
                await delay(3000);
            }
            
            logger.info(`Successfully interacted with ${successfulInteractions}/${postsToInteract.length} feed posts`);
            return successfulInteractions > 0;
        } catch (error) {
            logger.error('Error interacting with feed posts:', error);
            return false;
        }
    }

    async interactWithPosts(username, numPosts = 3) {
        try {
            const posts = await this.findPosts(username);
            
            // Limit to specified number of posts
            const postsToInteract = posts.slice(0, numPosts);
            
            for (let i = 0; i < postsToInteract.length; i++) {
                const post = postsToInteract[i];
                logger.info(`Interacting with post ${i + 1}/${postsToInteract.length}`);
                
                // Like the post
                await this.likePost(post);
                await delay(2000);
                
                // Add a comment
                const comments = [
                    "Great post! 👍",
                    "Love this! ❤️",
                    "Amazing content! 🔥",
                    "Thanks for sharing! 🙌",
                    "Interesting perspective! 💭"
                ];
                const randomComment = comments[Math.floor(Math.random() * comments.length)];
                await this.commentOnPost(post, randomComment);
                await delay(3000);
            }
            
            logger.info('Successfully interacted with posts');
            return true;
        } catch (error) {
            logger.error('Error interacting with posts:', error);
            return false;
        }
    }

    async useBrowserUseHelper(comment) {
        try {
            // Get the current page URL
            const currentUrl = await this.page.url();
            logger.info(`Current page URL: ${currentUrl}`);

            // Get browser debugging info
            const browserWSEndpoint = await this.browser.wsEndpoint();
            logger.info(`Browser WS Endpoint: ${browserWSEndpoint}`);

            // Get Python path and helper path
            const pythonExe = process.platform === 'win32' ? 'py' : 'python3.11';
            const helperPath = path.resolve(process.cwd(), '..', '..', 'browser_use_threads', 'browser-use-main', 'test_browser.py');
            
            logger.info(`Helper script path: ${helperPath}`);
            
            // Build command arguments
            const args = [
                ...(process.platform === 'win32' ? ['-3.11'] : []),
                helperPath,
                `"${comment}"`,  // Quote the comment
                `"${currentUrl}"`,  // Quote the URL
                '--ws-endpoint',
                `"${browserWSEndpoint}"`  // Quote the endpoint
            ];
            
            logger.info(`Executing helper with args: ${args.join(' ')}`);
            
            // Pass browser endpoint, comment and URL as arguments
            const { spawn } = require('child_process');
            const helperProcess = spawn(pythonExe, args, {
                stdio: 'pipe',
                env: {
                    ...process.env,
                    THREADS_USERNAME_1: process.env.THREADS_USERNAME_1,
                    THREADS_PASSWORD_1: process.env.THREADS_PASSWORD_1,
                    OPENAI_API_KEY: process.env.OPENAI_API_KEY
                },
                shell: true
            });

            // Log output from the helper
            helperProcess.stdout.on('data', (data) => {
                logger.info(`Browser-use helper output: ${data}`);
            });

            helperProcess.stderr.on('data', (data) => {
                logger.error(`Browser-use helper error: ${data}`);
            });

            // Wait for the process to complete
            await new Promise((resolve, reject) => {
                helperProcess.on('close', (code) => {
                    logger.info(`Browser-use helper process exited with code ${code}`);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Helper process failed with code ${code}`));
                    }
                });
                
                helperProcess.on('error', (err) => {
                    logger.error('Failed to start helper process:', err);
                    reject(err);
                });
            });
        } catch (error) {
            logger.error('Error using browser-use helper:', error);
            throw error;
        }
    }

    async commentOnPost(post, retryCount = 2) {
        try {
            // Ensure post is in viewport and wait for it to be stable
            await post.evaluate(el => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            await delay(2000);

            let commentText;
            
            // Get post text and generate AI response
            const postText = await this.getPostText(post);
            if (postText) {
                const aiResponse = await this.generateAIResponse(postText);
                if (aiResponse) {
                    commentText = aiResponse;
                }
            }

            // Fall back to random comment if no AI response
            if (!commentText) {
                const fallbackComments = [
                    "Interesting point! 💡",
                    "Great insight! 🤔",
                    "Thanks for sharing! ✨",
                    "Love this perspective! 💭",
                    "Well said! 👏"
                ];
                commentText = fallbackComments[Math.floor(Math.random() * fallbackComments.length)];
            }

            // Immediately use the browser-use helper after generating the comment
            logger.info('Using browser-use helper for commenting...');
            await this.useBrowserUseHelper(commentText);

        } catch (error) {
            logger.error('Error in comment process:', error);
            return false;
        }
    }

    async cleanup() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
            if (this.proxyServer) {
                await this.proxyServer.close(true);
                this.proxyServer = null;
            }
            logger.info('ThreadsAgent cleanup completed');
        } catch (error) {
            logger.error('Error during ThreadsAgent cleanup:', error);
        }
    }
}

module.exports = ThreadsAgent;
