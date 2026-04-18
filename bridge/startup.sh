#!/bin/bash

# Riona Bridge Service Startup Script for macOS/zsh
# Starts the inter-service bridge with proper error handling

set -e  # Exit on error

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🌉 Starting Riona Bridge Service${NC}"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPT_DIR" )"

cd "$PROJECT_ROOT"

# Set default bridge port
export BRIDGE_PORT="${BRIDGE_PORT:-3850}"

echo -e "${GREEN}✓ Bridge port: $BRIDGE_PORT${NC}"

# Check if dependencies are installed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${BLUE}📦 Installing bridge dependencies...${NC}"
    npm install --prefix "$SCRIPT_DIR"
fi

# Build TypeScript
if [ ! -d "$SCRIPT_DIR/build" ]; then
    echo -e "${BLUE}📝 Compiling TypeScript for bridge...${NC}"
    npm run build --prefix "$SCRIPT_DIR"
fi

# Start the bridge service
echo -e "${GREEN}✓ Starting bridge service...${NC}"
npm run start --prefix "$SCRIPT_DIR"
