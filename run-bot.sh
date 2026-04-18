#!/bin/bash

# Riona Instagram Bot Launcher for macOS/zsh
# Sets environment variables and starts the bot

set -e  # Exit on error

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Riona Instagram Bot${NC}"

# Set environment variables for Instagram automation
export INSTAGRAM_BOT_USERNAME="the_isaiah_dupree_"
export INSTAGRAM_BOT_PASSWORD="SkyCloud12!@"
export INSTAGRAM_PROXY_PORT="9000"
export INSTAGRAM_PROXY_HOST="localhost"
export USE_PROXY="false"
export PROXY_ENABLED="true"

# Optional: Set browser type (chrome or safari)
# export BROWSER_TYPE="safari"

# Optional: Enable web server for UI (trace/HITL)
# export WEB_SERVER_ENABLED="true"

echo -e "${GREEN}✓ Environment variables set${NC}"
echo -e "${GREEN}✓ INSTAGRAM_BOT_USERNAME: $INSTAGRAM_BOT_USERNAME${NC}"
echo -e "${GREEN}✓ PROXY_ENABLED: $PROXY_ENABLED${NC}"

# Check if node_modules exists, if not run npm install
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm install
fi

# Compile TypeScript
echo -e "${BLUE}📝 Compiling TypeScript...${NC}"
npm run build

# Start the bot
echo -e "${BLUE}🤖 Starting bot process...${NC}"
node build/index.js
