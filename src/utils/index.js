"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveScrapedData = exports.canSendTweet = exports.checkAndDeleteOldTweetData = exports.saveTweetData = exports.getNextApiKey = void 0;
exports.Instagram_cookiesExist = Instagram_cookiesExist;
exports.saveCookies = saveCookies;
exports.loadCookies = loadCookies;
exports.handleError = handleError;
exports.setup_HandleError = setup_HandleError;
exports.checkRequiredEnvVars = checkRequiredEnvVars;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const secret_1 = require("../secret");
const logger_1 = __importDefault(require("../config/logger"));

function checkRequiredEnvVars() {
    logger_1.default.info("Checking environment variables...");
    const requiredVars = [
        'IG_USERNAME_1',
        'IG_PASSWORD_1'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        const error = `Missing required environment variables: ${missingVars.join(', ')}`;
        logger_1.default.error(error);
        throw new Error(error);
    }
    
    logger_1.default.info("All required environment variables are present.");
    return true;
}

async function Instagram_cookiesExist() {
    try {
        const cookiesPath = "./cookies/Instagramcookies.json";
        await fs_1.promises.access(cookiesPath); // Check if file exists
        const cookiesData = await fs_1.promises.readFile(cookiesPath, "utf-8");
        const cookies = JSON.parse(cookiesData);
        // Priority-based cookie validation
        const primaryCookie = cookies.find((cookie) => cookie.name === 'sessionid');
        const fallbackCookie = cookies.find((cookie) => cookie.name === 'csrftoken');
        const currentTimestamp = Math.floor(Date.now() / 1000);
        // Validate primary cookie (sessionid)
        if (primaryCookie && primaryCookie.expires > currentTimestamp) {
            return true;
        }
        // Fallback to csrftoken if sessionid is missing or expired
        if (fallbackCookie && fallbackCookie.expires > currentTimestamp) {
            return true;
        }
        return false;
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            logger_1.default.warn("Cookies file does not exist.");
            return false;
        }
        else {
            logger_1.default.error("Error checking cookies:", error);
            return false;
        }
    }
}
async function saveCookies(cookiesPath, cookies) {
    try {
        await fs_1.promises.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
        logger_1.default.info("Cookies saved successfully.");
    }
    catch (error) {
        logger_1.default.error("Error saving cookies:", error);
        throw new Error("Failed to save cookies.");
    }
}
async function loadCookies(cookiesPath) {
    try {
        // Check if the file exists
        await fs_1.promises.access(cookiesPath);
        // Read and parse the cookies file
        const cookiesData = await fs_1.promises.readFile(cookiesPath, "utf-8");
        const cookies = JSON.parse(cookiesData);
        return cookies;
    }
    catch (error) {
        logger_1.default.error("Cookies file does not exist or cannot be read.", error);
        return [];
    }
}
// Function to get the next API key in the list
const getNextApiKey = (currentApiKeyIndex) => {
    currentApiKeyIndex = (currentApiKeyIndex + 1) % secret_1.geminiApiKeys.length; // Circular rotation of API keys
    return secret_1.geminiApiKeys[currentApiKeyIndex];
};
exports.getNextApiKey = getNextApiKey;
async function handleError(error, currentApiKeyIndex, schema, prompt, runAgent) {
    if (error instanceof Error) {
        if (error.message.includes("429 Too Many Requests")) {
            logger_1.default.error(`---GEMINI_API_KEY_${currentApiKeyIndex + 1} limit exhausted, switching to the next API key...`);
            const geminiApiKey = (0, exports.getNextApiKey)(currentApiKeyIndex);
            const currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;
            return runAgent(schema, prompt);
        }
        else if (error.message.includes("503 Service Unavailable")) {
            logger_1.default.error("Service is temporarily unavailable. Retrying...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            return runAgent(schema, prompt);
        }
        else {
            logger_1.default.error(`Error generating training prompt: ${error.message}`);
            return `An error occurred: ${error.message}`;
        }
    }
    else {
        logger_1.default.error("An unknown error occurred:", error);
        return "An unknown error occurred.";
    }
}
function setup_HandleError(error, context) {
    if (error instanceof Error) {
        if (error.message.includes("net::ERR_ABORTED")) {
            logger_1.default.error(`ABORTION error occurred in ${context}: ${error.message}`);
        }
        else {
            logger_1.default.error(`Error in ${context}: ${error.message}`);
        }
    }
    else {
        logger_1.default.error(`An unknown error occurred in ${context}: ${error}`);
    }
}
// Function to save tweet data to tweetData.json
const saveTweetData = async function (tweetContent, imageUrl, timeTweeted) {
    const tweetDataPath = path_1.default.join(__dirname, '../data/tweetData.json');
    const tweetData = {
        tweetContent,
        imageUrl: imageUrl || null,
        timeTweeted,
    };
    try {
        // Check if the file exists
        await fs_1.promises.access(tweetDataPath);
        // Read the existing data
        const data = await fs_1.promises.readFile(tweetDataPath, 'utf-8');
        const json = JSON.parse(data);
        // Append the new tweet data
        json.push(tweetData);
        // Write the updated data back to the file
        await fs_1.promises.writeFile(tweetDataPath, JSON.stringify(json, null, 2));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist, create it with the new tweet data
            await fs_1.promises.writeFile(tweetDataPath, JSON.stringify([tweetData], null, 2));
        }
        else {
            logger_1.default.error('Error saving tweet data:', error);
            throw error;
        }
    }
};
exports.saveTweetData = saveTweetData;
// Function to check if the first object's time in tweetData.json is more than 24 hours old and delete the file if necessary
const checkAndDeleteOldTweetData = async function () {
    const tweetDataPath = path_1.default.join(__dirname, '../data/tweetData.json');
    try {
        // Check if the file exists
        await fs_1.promises.access(tweetDataPath);
        // Read the existing data
        const data = await fs_1.promises.readFile(tweetDataPath, 'utf-8');
        const json = JSON.parse(data);
        if (json.length > 0) {
            const firstTweetTime = new Date(json[0].timeTweeted).getTime();
            const currentTime = Date.now();
            const timeDifference = currentTime - firstTweetTime;
            // Check if the time difference is more than 24 hours (86400000 milliseconds)
            if (timeDifference > 86400000) {
                await fs_1.promises.unlink(tweetDataPath);
                logger_1.default.info('tweetData.json file deleted because the first tweet is more than 24 hours old.');
            }
        }
    }
    catch (error) {
        const err = error;
        if (err.code !== 'ENOENT') {
            logger_1.default.error('Error checking tweet data:', err);
            throw err;
        }
    }
};
exports.checkAndDeleteOldTweetData = checkAndDeleteOldTweetData;
// Function to check if the tweetData.json file has 17 or more objects
const canSendTweet = async function () {
    const tweetDataPath = path_1.default.join(__dirname, '../data/tweetData.json');
    try {
        // Check if the file exists
        await fs_1.promises.access(tweetDataPath);
        // Read the existing data
        const data = await fs_1.promises.readFile(tweetDataPath, 'utf-8');
        const json = JSON.parse(data);
        // Check if the file has 17 or more objects
        if (json.length >= 17) {
            return false;
        }
        return true;
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            // File does not exist, so it's safe to send a tweet
            return true;
        }
        else {
            logger_1.default.error('Error checking tweet data:', err);
            throw err;
        }
    }
};
exports.canSendTweet = canSendTweet;
/// Function to save scraped data to scrapedData.json
const saveScrapedData = async function (link, content) {
    const scrapedDataPath = path_1.default.join(__dirname, '../data/scrapedData.json');
    const scrapedDataDir = path_1.default.dirname(scrapedDataPath);
    const scrapedData = {
        link,
        content,
    };
    try {
        // Ensure the directory exists
        await fs_1.promises.mkdir(scrapedDataDir, { recursive: true });
        // Check if the file exists
        await fs_1.promises.access(scrapedDataPath);
        // Read the existing data
        const data = await fs_1.promises.readFile(scrapedDataPath, 'utf-8');
        const json = JSON.parse(data);
        // Append the new scraped data
        json.push(scrapedData);
        // Write the updated data back to the file
        await fs_1.promises.writeFile(scrapedDataPath, JSON.stringify(json, null, 2));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist, create it with the new scraped data
            await fs_1.promises.writeFile(scrapedDataPath, JSON.stringify([scrapedData], null, 2));
        }
        else {
            logger_1.default.error('Error saving scraped data:', error);
            throw error;
        }
    }
};
exports.saveScrapedData = saveScrapedData;
