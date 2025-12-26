# Riona AI Agent - Skeleton Setup

This guide helps you get the basic skeleton working before full dockerization.

## Quick Start

### 1. Copy Environment File (from root directory)
```powershell
# From the root project directory (not frontend)
cd C:\Users\Isaia\Documents\Coding\Riona_v3
cp .env.example .env
```

### 2. Install Dependencies
```powershell
# Backend dependencies
npm install

# Frontend dependencies  
cd frontend
npm install
cd ..
```

### 3. Basic Configuration
Edit `.env` file with minimal settings:
```env
# Minimal required config
WEB_SERVER_ENABLED=true
PORT=3000
NODE_ENV=development

# Optional: Database (leave blank to skip MongoDB for now)
MONGODB_URI=

# Optional: Instagram credentials (leave blank for skeleton testing)
INSTAGRAM_BOT_USERNAME=
INSTAGRAM_BOT_PASSWORD=
```

## Testing the Skeleton

### 1. Test TypeScript Compilation
```powershell
npm run build
```

### 2. Start Basic Server
```powershell
npm run dev
```

### 3. Test Endpoints
Open browser to:
- Health check: http://localhost:3000/health
- API status: http://localhost:3000/api/status

### 4. Test Frontend (separate terminal)
```powershell
cd frontend
npm run dev
```

### 5. Test Database Connection (optional)
```powershell
npm run build
node build/db-test.js
```

## Available Commands

- `npm run dev` - Start basic development server
- `npm run build` - Compile TypeScript 
- `npm run health` - Check if server is running
- `npm run build:all` - Build both backend and frontend

## Troubleshooting

### TLS Error
The npm TLS warning is just informational - your packages installed correctly.

### Missing .env File
The `.env.example` is in the root directory, not in `frontend/`. Copy it from the root.

### TypeScript Errors
Run `npm install --save-dev @types/node` if you see TypeScript compilation issues.

### MongoDB Connection
If you don't have MongoDB installed, leave `MONGODB_URI` blank in `.env` - the skeleton will work without it.

## Next Steps

Once skeleton is working:
1. Add MongoDB connection
2. Add Instagram credentials  
3. Test full integration
4. Prepare for dockerization
