require('dotenv').config();

module.exports = {
    apps: [
        {
            name: "riona-scheduler",
            script: "./build/scheduler.js",
            watch: false,
            max_memory_restart: "500M",
            // Auto-restart on crash, max 5 restarts in 5 min window
            max_restarts: 5,
            min_uptime: "30s",
            restart_delay: 60000, // 1 min between restarts
            env: {
                NODE_ENV: "production",
                // Scheduling
                DAILY_COMMENT_TARGET: process.env.DAILY_COMMENT_TARGET || "500",
                POSTS_PER_RUN: process.env.POSTS_PER_RUN || "15",
                ACTIVE_HOURS_START: process.env.ACTIVE_HOURS_START || "9",
                ACTIVE_HOURS_END: process.env.ACTIVE_HOURS_END || "22",
                RUN_INTERVAL_MINUTES: process.env.RUN_INTERVAL_MINUTES || "20",
                // Instagram
                INSTAGRAM_BOT_USERNAME: process.env.INSTAGRAM_BOT_USERNAME,
                INSTAGRAM_BOT_PASSWORD: process.env.INSTAGRAM_BOT_PASSWORD,
                INSTAGRAM_PROXY_PORT: process.env.INSTAGRAM_PROXY_PORT,
                INSTAGRAM_PROXY_HOST: process.env.INSTAGRAM_PROXY_HOST,
                INSTAGRAM_USE_PROXY: process.env.INSTAGRAM_USE_PROXY,
                INSTAGRAM_TIMEOUT_MS: process.env.INSTAGRAM_TIMEOUT_MS,
                // APIs
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1,
                MONGODB_URI: process.env.MONGODB_URI,
                // Server
                WEB_SERVER_ENABLED: process.env.WEB_SERVER_ENABLED,
                PORT: process.env.PORT,
                // Supabase
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_KEY: process.env.SUPABASE_KEY,
                LOG_LEVEL: process.env.LOG_LEVEL,
                // Telegram
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
            }
        },
        {
            name: "riona-threads",
            script: "./build/threads-scheduler.js",
            watch: false,
            max_memory_restart: "500M",
            max_restarts: 5,
            min_uptime: "30s",
            restart_delay: 60000,
            env: {
                NODE_ENV: "production",
                // Threads scheduling
                THREADS_DAILY_TARGET: process.env.THREADS_DAILY_TARGET || "500",
                THREADS_POSTS_PER_RUN: process.env.THREADS_POSTS_PER_RUN || "15",
                THREADS_INTERVAL_MINUTES: process.env.THREADS_INTERVAL_MINUTES || "15",
                THREADS_TIMEOUT_MS: process.env.THREADS_TIMEOUT_MS || "30000",
                ACTIVE_HOURS_START: process.env.ACTIVE_HOURS_START || "9",
                ACTIVE_HOURS_END: process.env.ACTIVE_HOURS_END || "22",
                // Threads credentials
                THREADS_BOT_USERNAME: process.env.THREADS_BOT_USERNAME,
                THREADS_BOT_PASSWORD: process.env.THREADS_BOT_PASSWORD,
                // APIs
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                MONGODB_URI: process.env.MONGODB_URI,
                // Supabase
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_KEY: process.env.SUPABASE_KEY,
                LOG_LEVEL: process.env.LOG_LEVEL,
                // Telegram
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
            }
        },
        {
            name: "riona-dm-watcher",
            script: "./build/dm-scheduler.js",
            watch: false,
            max_memory_restart: "500M",
            max_restarts: 5,
            min_uptime: "30s",
            restart_delay: 60000,
            env: {
                NODE_ENV: "production",
                DM_CHECK_INTERVAL_MINUTES: process.env.DM_CHECK_INTERVAL_MINUTES || "5",
                DM_PIPELINE_INTERVAL_MINUTES: process.env.DM_PIPELINE_INTERVAL_MINUTES || "30",
                // Instagram
                INSTAGRAM_BOT_USERNAME: process.env.INSTAGRAM_BOT_USERNAME,
                INSTAGRAM_BOT_PASSWORD: process.env.INSTAGRAM_BOT_PASSWORD,
                // APIs
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                // Supabase
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_KEY: process.env.SUPABASE_KEY,
                LOG_LEVEL: process.env.LOG_LEVEL,
                // Telegram
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
            }
        },
        {
            name: "riona-twitter",
            script: "./build/twitter-scheduler.js",
            watch: false,
            max_memory_restart: "500M",
            max_restarts: 5,
            min_uptime: "30s",
            restart_delay: 60000,
            env: {
                NODE_ENV: "production",
                // Twitter scheduling
                TWITTER_DAILY_TARGET: process.env.TWITTER_DAILY_TARGET || "200",
                TWITTER_POSTS_PER_RUN: process.env.TWITTER_POSTS_PER_RUN || "10",
                TWITTER_INTERVAL_MINUTES: process.env.TWITTER_INTERVAL_MINUTES || "25",
                TWITTER_TIMEOUT_MS: process.env.TWITTER_TIMEOUT_MS || "60000",
                ACTIVE_HOURS_START: process.env.ACTIVE_HOURS_START || "9",
                ACTIVE_HOURS_END: process.env.ACTIVE_HOURS_END || "22",
                // Twitter credentials
                TWITTER_BOT_USERNAME: process.env.TWITTER_BOT_USERNAME,
                TWITTER_BOT_PASSWORD: process.env.TWITTER_BOT_PASSWORD,
                // Niche search terms
                TWITTER_NICHE_HASHTAGS: process.env.TWITTER_NICHE_HASHTAGS || "",
                TWITTER_NICHE_POSTS_PER_RUN: process.env.TWITTER_NICHE_POSTS_PER_RUN || "10",
                TWITTER_NICHE_RUN_FREQUENCY: process.env.TWITTER_NICHE_RUN_FREQUENCY || "3",
                // APIs
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                MONGODB_URI: process.env.MONGODB_URI,
                // Supabase
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_KEY: process.env.SUPABASE_KEY,
                LOG_LEVEL: process.env.LOG_LEVEL,
                // Telegram
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
            }
        },
        {
            name: "riona-twitter-dm",
            script: "./build/twitter-dm-scheduler.js",
            watch: false,
            max_memory_restart: "500M",
            max_restarts: 5,
            min_uptime: "30s",
            restart_delay: 60000,
            env: {
                NODE_ENV: "production",
                TWITTER_DM_CHECK_INTERVAL_MINUTES: process.env.TWITTER_DM_CHECK_INTERVAL_MINUTES || "5",
                TWITTER_DM_PIPELINE_INTERVAL_MINUTES: process.env.TWITTER_DM_PIPELINE_INTERVAL_MINUTES || "30",
                TWITTER_MAX_DMS_PER_DAY: process.env.TWITTER_MAX_DMS_PER_DAY || "30",
                // Twitter credentials
                TWITTER_BOT_USERNAME: process.env.TWITTER_BOT_USERNAME,
                TWITTER_BOT_PASSWORD: process.env.TWITTER_BOT_PASSWORD,
                // APIs
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                // Supabase
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_KEY: process.env.SUPABASE_KEY,
                LOG_LEVEL: process.env.LOG_LEVEL,
                // Telegram
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
            }
        }
    ]
};
