"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const instagram_private_api_1 = require("instagram-private-api");
const request_promise_1 = require("request-promise");
const cron_1 = require("cron");
// InstagramClient Class
class InstagramClient {
    username;
    password;
    ig;
    constructor(username, password) {
        if (!username || !password) {
            throw new Error("Username and password are required.");
        }
        this.ig = new instagram_private_api_1.IgApiClient();
        this.username = username;
        this.password = password;
    }
    async login() {
        console.log(`Logging in as ${this.username}...`);
        this.ig.state.generateDevice(this.username);
        await this.ig.account.login(this.username, this.password);
        console.log("Login successful!");
    }
    async postPhoto(url, caption = '') {
        if (!url) {
            throw new Error("Image URL is required.");
        }
        console.log("Fetching image...");
        const imageBuffer = await (0, request_promise_1.get)({
            url,
            encoding: null, // Ensures image is retrieved as a buffer
        });
        console.log("Uploading photo...");
        const response = await this.ig.publish.photo({
            file: imageBuffer,
            caption,
        });
        console.log("Photo posted successfully!");
        return response;
    }
    async schedulePost(url, caption, cronTime) {
        if (!url || !cronTime) {
            throw new Error("Image URL and cron time are required.");
        }
        console.log(`Scheduling post for: ${cronTime}`);
        const job = new cron_1.CronJob(cronTime, async () => {
            try {
                await this.postPhoto(url, caption);
            }
            catch (error) {
                console.error("Error during scheduled post:", error.message);
            }
        });
        job.start();
        console.log("Cron job started.");
    }
}
// Usage Example
(async () => {
    const username = process.env.IG_USERNAME; // Set your Instagram username in environment variables
    const password = process.env.IG_PASSWORD; // Set your Instagram password in environment variables
    if (!username || !password) {
        console.error("Please set IG_USERNAME and IG_PASSWORD in environment variables.");
        return;
    }
    const client = new InstagramClient(username, password);
    try {
        await client.login();
        // Post immediately
        await client.postPhoto('https://i.imgur.com/BZBHsauh.jpg', 'Really nice photo from the internet!');
        // Schedule a post
        await client.schedulePost('https://i.imgur.com/BZBHsauh.jpg', 'Scheduled post with a great view!', '0 9 * * *' // Cron time: Every day at 9 AM
        );
    }
    catch (error) {
        console.error("Error:", error.message);
    }
})();
