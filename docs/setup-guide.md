# Riona Instagram AI Agent - Setup Guide

This guide covers the complete setup and deployment of the Riona Instagram AI Agent with traceability and Human-in-the-Loop (HITL) moderation system.

## Prerequisites

### System Requirements
- **Node.js**: v16 or higher
- **MongoDB**: v5.0 or higher
- **npm**: v7 or higher
- **Git**: Latest version
- **Operating System**: Windows 10+, macOS 10.15+, or Linux (Ubuntu 18.04+)

### Required Accounts
- Instagram account for the bot
- MongoDB Atlas account (or local MongoDB installation)
- PM2 Plus account (optional, for monitoring)

## Installation

### 1. Clone the Repository
```bash
git clone <repository-url>
cd Riona_v3
```

### 2. Install Backend Dependencies
```bash
npm install
npm install --save-dev @types/node
```

### 3. Install Frontend Dependencies
```bash
cd frontend
npm install
cd ..
```

### 4. Environment Configuration

Copy the example environment file and configure it:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Instagram Bot Credentials
INSTAGRAM_BOT_USERNAME=your_bot_username
INSTAGRAM_BOT_PASSWORD=your_bot_password

# Database Configuration
MONGODB_URI=mongodb://localhost:27017/riona
# OR for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/riona

# Web Server Configuration
WEB_SERVER_ENABLED=true
PORT=3000
FRONTEND_PORT=5173

# Deep Linking Configuration
DOCS_BASE_URL=https://your-docs.com
REPO_URL=https://github.com/yourusername/riona_v3
REPO_MAIN_BRANCH=main
ARTIFACT_BASE_URL=http://localhost:3000/artifacts
LOG_UI_BASE_URL=http://localhost:3000/logs
PM2_DASHBOARD_URL=https://app.pm2.io

# Traceability Configuration
TRACE_WEBHOOK_URL=http://localhost:3000/webhooks/trace
TRACE_WEBHOOK_SECRET=your_webhook_secret_here

# Logging Configuration
LOG_LEVEL=info
LOG_DIR=./logs

# Security Configuration
JWT_SECRET=your_jwt_secret_here
ADMIN_API_KEY=your_admin_api_key_here
```

### 5. Database Setup

Start MongoDB (if running locally):
```bash
# On Windows with MongoDB installed
net start MongoDB

# On macOS with Homebrew
brew services start mongodb-community

# On Linux
sudo systemctl start mongod
```

Initialize the database:
```bash
npm run init-db
```

This will:
- Create necessary MongoDB collections
- Set up indexes for optimal performance
- Seed default response styles
- Verify database connectivity

## Running the Application

### Development Mode

#### 1. Start the Backend Server
```bash
npm run dev
```

This starts the Express server with:
- Traceability API endpoints
- HITL moderation API
- Webhook handlers
- Log tailing endpoints

#### 2. Start the Frontend (in a separate terminal)
```bash
cd frontend
npm run dev
```

This starts the React development server for the moderation console.

#### 3. Access the Application
- **Moderation Console**: http://localhost:5173
- **API Endpoints**: http://localhost:3000/api
- **Health Check**: http://localhost:3000/health

### Production Mode

#### 1. Build the Frontend
```bash
cd frontend
npm run build
cd ..
```

#### 2. Start with PM2
```bash
npm install -g pm2
npm run start:prod
```

OR start manually:
```bash
npm run build
npm start
```

## API Endpoints

### Traceability API
- `GET /api/trace/runs` - List recent trace runs
- `GET /api/trace/runs/:runId` - Get specific run details
- `GET /api/trace/runs/job/:jobName` - Get runs by job name
- `GET /api/trace/logs/:filename/tail` - Tail log files

### HITL Moderation API
- `GET /api/hitl/moderation/items` - List pending moderation items
- `POST /api/hitl/moderation/approve/:itemId` - Approve an item
- `POST /api/hitl/moderation/deny/:itemId` - Deny an item
- `POST /api/hitl/moderation/revise/:itemId` - Request revision

### Account Management API
- `GET /api/hitl/accounts` - List bot accounts
- `POST /api/hitl/accounts` - Create new account
- `PUT /api/hitl/accounts/:accountId` - Update account
- `DELETE /api/hitl/accounts/:accountId` - Delete account

### Response Styles API
- `GET /api/hitl/styles` - List response styles
- `POST /api/hitl/styles` - Create new style
- `PUT /api/hitl/styles/:styleId` - Update style
- `DELETE /api/hitl/styles/:styleId` - Delete style

## Configuration Guide

### Instagram Bot Configuration

1. **Create Instagram Account**: Set up a dedicated Instagram account for the bot
2. **Configure Credentials**: Add credentials to `.env` file
3. **Test Connection**: Run the bot in development mode to verify connectivity

### MongoDB Configuration

#### Local MongoDB
```env
MONGODB_URI=mongodb://localhost:27017/riona
```

#### MongoDB Atlas
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/riona?retryWrites=true&w=majority
```

### Security Configuration

#### JWT Configuration
Generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### API Key Configuration
Generate a secure API key for admin operations:
```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### Webhook Configuration

For production deployments, configure webhooks to receive real-time updates:
```env
TRACE_WEBHOOK_URL=https://your-domain.com/webhooks/trace
TRACE_WEBHOOK_SECRET=secure_webhook_secret
```

## Monitoring and Logging

### Log Files
- **Application Logs**: `./logs/app.log`
- **Error Logs**: `./logs/error.log`
- **Trace Logs**: `./logs/trace.log`
- **HITL Logs**: `./logs/hitl.log`

### PM2 Monitoring
```bash
# View process status
pm2 status

# View logs
pm2 logs riona

# Monitor in real-time
pm2 monit

# Restart application
pm2 restart riona
```

### Health Checks
The application provides health check endpoints:
- `GET /health` - Overall system health
- `GET /health/database` - Database connectivity
- `GET /health/instagram` - Instagram API status

## Troubleshooting

### Common Issues

#### 1. MongoDB Connection Failed
**Error**: `MongoDB connection error`
**Solution**:
- Verify MongoDB is running
- Check connection string in `.env`
- Ensure firewall allows connection
- For Atlas: Verify IP whitelist and credentials

#### 2. Instagram Login Failed
**Error**: `Instagram authentication failed`
**Solution**:
- Verify username/password in `.env`
- Check if account is locked/suspended
- Enable 2FA and use app password if required
- Use a fresh IP/proxy if rate limited

#### 3. Frontend Build Failed
**Error**: `Module not found` errors
**Solution**:
```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run build
```

#### 4. TypeScript Compilation Errors
**Error**: `Cannot find module` or type declaration errors
**Solution**:
```bash
npm install --save-dev @types/node @types/express
```

#### 5. Port Already in Use
**Error**: `EADDRINUSE: address already in use`
**Solution**:
```bash
# Find and kill process using port
npx kill-port 3000
npx kill-port 5173
```

### Performance Optimization

#### 1. Database Indexing
Ensure indexes are created (run automatically with `init-db`):
```javascript
// Trace records
db.tracerecords.createIndex({ "runId": 1 })
db.tracerecords.createIndex({ "jobName": 1, "startTime": -1 })

// HITL collections
db.interactions.createIndex({ "accountId": 1, "createdAt": -1 })
db.approvalitems.createIndex({ "status": 1, "createdAt": -1 })
```

#### 2. Log Rotation
Configure log rotation to prevent disk space issues:
```bash
# Install logrotate (Linux)
sudo apt install logrotate

# Add to /etc/logrotate.d/riona
/path/to/riona/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0644 nodejs nodejs
}
```

#### 3. Memory Management
Monitor memory usage:
```bash
# View memory usage
pm2 monit

# Restart if memory usage is high
pm2 restart riona
```

### Security Best Practices

1. **Environment Variables**: Never commit `.env` files to version control
2. **API Keys**: Rotate API keys regularly
3. **Database Security**: Use authentication and encryption for MongoDB
4. **HTTPS**: Use HTTPS in production
5. **Rate Limiting**: Implement rate limiting for API endpoints
6. **Input Validation**: Validate all user inputs
7. **Webhook Security**: Use HMAC signing for webhooks

## Deployment

### Docker Deployment (Optional)

Create `Dockerfile`:
```dockerfile
FROM node:16-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN cd frontend && npm ci && npm run build

EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t riona .
docker run -p 3000:3000 --env-file .env riona
```

### Cloud Deployment

#### AWS/Azure/GCP
1. Set up virtual machine or container service
2. Configure environment variables
3. Set up MongoDB Atlas or cloud database
4. Configure domain and SSL certificate
5. Set up monitoring and alerts

#### Heroku
```bash
# Install Heroku CLI
npm install -g heroku

# Login and create app
heroku login
heroku create riona-app

# Add MongoDB addon
heroku addons:create mongolab:sandbox

# Set environment variables
heroku config:set INSTAGRAM_BOT_USERNAME=your_username
heroku config:set INSTAGRAM_BOT_PASSWORD=your_password

# Deploy
git push heroku main
```

## Support

For issues and questions:
1. Check this documentation
2. Review error logs in `./logs/`
3. Check GitHub issues
4. Contact the development team

## Version Information

- **Current Version**: 1.0.0
- **Node.js Compatibility**: v16+
- **MongoDB Compatibility**: v5.0+
- **Last Updated**: September 13, 2025
