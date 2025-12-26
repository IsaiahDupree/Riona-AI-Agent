require('dotenv').config();

module.exports = {
    apps: [
        {
            name: "instagram-scheduler",
            script: "./build/index.js",
            watch: false,
            env: {
                NODE_ENV: "development",
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
                GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1,
                MONGODB_URI: process.env.MONGODB_URI,
                INSTAGRAM_BOT_USERNAME: process.env.INSTAGRAM_BOT_USERNAME,
                INSTAGRAM_BOT_PASSWORD: process.env.INSTAGRAM_BOT_PASSWORD,
                INSTAGRAM_PROXY_PORT: process.env.INSTAGRAM_PROXY_PORT,
                INSTAGRAM_PROXY_HOST: process.env.INSTAGRAM_PROXY_HOST,
                WEB_SERVER_ENABLED: process.env.WEB_SERVER_ENABLED,
                PORT: process.env.PORT,
                LOG_LEVEL: process.env.LOG_LEVEL
            },
            env_production: {
                NODE_ENV: "production"
            }
        }
    ]
};
