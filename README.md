## Riona-AI-Agent 🌸

Riona-AI-Agent is an AI-powered automation tool designed for **Instagram** to automate social media interactions such as posting, liking, and commenting. It leverages advanced AI models to generate engaging content, automate interactions, and manage Instagram accounts efficiently.

For a high-level guide to how the system runs, see the How It Works overview: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

Before using the automation features, you can personalize the agent by training with the following, including:

- **YouTube Video URL** 🎥
- **Audio File** 🎙️
- **Portfolio or Website Link** 🌐
- **File Formats Supported**: PDF, DOC, DOCX, TXT 📄

## Features

### Automated Instagram Interactions
- **Login**: Secure login with cookie persistence
- **Post Discovery**: Smart post finding and filtering
- **Liking**: Reliable post liking functionality
- **Caption Extraction**: 
  - Advanced multi-method caption extraction
  - Handles expanded captions with "more" button clicks
  - Robust visibility checking and validation
  - Detailed logging for debugging
- **Comment Management**:
  - Smart duplicate comment detection
  - Multiple validation methods to check existing comments
  - Reliable comment posting with center-click method
  - Multi-step validation to confirm comment success

### Advanced Features
- **Robust Error Handling**: Comprehensive error handling and recovery
- **Debug Logging**: Detailed logging for troubleshooting
- **State Management**: Efficient handling of Instagram's dynamic content
- **Performance Optimization**: Smart waiting and loading strategies

### Technical Implementation
- TypeScript-based for type safety
- Puppeteer for browser automation
- Proxy support for request management
- Detailed logging system
- Error handling and recovery

### AI-Powered Content Generation
- Use Google Generative AI to create engaging captions and comments.

### Proxy Support
- Use proxies to manage multiple accounts and avoid rate limits.

### Cookie Management
- Save and load cookies to maintain sessions across restarts.

**Upcoming Features:**

- **Twitter Automation**: (Coming soon) Automatically tweet, retweet, and like tweets.
- **GitHub Automation**: (Coming soon) Automatically manage repositories, issues, and pull requests.

## Installation

1. **Clone the repository**:

   ```sh
   git clone https://github.com/david-patrick-chuks/Riona-AI-Agent.git
   cd Riona-AI-Agent
   ```

2. **Install dependencies**:

   ```sh
   npm install
   ```

3. **Set up environment variables**:
   Rename the [.env.example](http://_vscodecontentref_/1) file to [.env](http://_vscodecontentref_/1) in the root directory and add your Instagram credentials. Refer to the [.env.example](http://_vscodecontentref_/2) file for the required variables.
   ```dotenv # Instagram credentials
   IGusername=your_instagram_username
   IGpassword=your_instagram_password 
   
   Xusername= #Twitter username
   Xpassword= #Twitter password

   MONGODB_URI= #MongoDB URI
   ```

## Usage

1. **Run the Instagram agent**:
   ```sh
   npm start
   ```

**Upcoming Features:**

- **Run the Twitter agent** (Coming soon):

  ```sh
  npm run start:twitter
  ```

- **Run the GitHub agent** (Coming soon):
  ```sh
  npm run start:github
  ```

## Monitoring and Logging

### Real-Time Monitoring
Monitor the bot's activity in real-time:
```powershell
.\monitor-logs.ps1
```

This provides:
- Live log updates with color coding
- Interaction statistics
- Error highlighting
- Performance metrics

### Log Files
- `logs/combined-YYYY-MM-DD.log`: All log levels
- `logs/error-YYYY-MM-DD.log`: Error messages only
- `logs/post_interactions.json`: Interaction records

For detailed information about logging and monitoring, see:
- [Logging and Monitoring Guide](docs/technical-docs/06-logging-and-monitoring.md)
- [Monitoring and Scheduling Guide](docs/technical-docs/07-monitoring-and-scheduling.md)

## Documentation

Detailed technical documentation is available in the `docs/technical-docs` directory:

1. [Logging and Monitoring Guide](docs/technical-docs/06-logging-and-monitoring.md)
2. [Monitoring and Scheduling Guide](docs/technical-docs/07-monitoring-and-scheduling.md)
3. [Traceability & Human-in-the-Loop (HITL)](docs/technical-docs/13-traceability-and-hitl.md)

These guides cover:
- Task scheduling and automation
- Real-time monitoring tools
- Log analysis and troubleshooting
- Performance optimization
- Security considerations

## Scheduling the Bot

### Windows Task Scheduler (Recommended)

1. Make sure you have set up all environment variables in `.env` file
2. Right-click on PowerShell and select "Run as Administrator"
3. Navigate to the project directory:
   ```powershell
   cd "C:\Users\Isaia\OneDrive\Documents\Coding\Instagram agent\This is the folder your looking for\Riona-AI-Agent-main"
   ```
4. Run the setup script:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup-scheduler.ps1
   ```

This will create a scheduled task that:
- Runs every 45 minutes
- Each run is limited to 5 minutes
- Automatically restarts if it crashes (up to 3 times)
- Runs with elevated privileges to ensure proper operation
- Includes proper error handling and logging

### Verifying the Schedule

1. Open Task Scheduler (Windows key + R, type "taskschd.msc")
2. Look for "Instagram Bot" task
3. Check these properties:
   - Next Run Time
   - Last Run Time
   - Last Run Result (should be 0x0)
   - Status (should be "Ready")

### Troubleshooting Schedule Issues

If the bot isn't running as scheduled:

1. Check the logs:
   ```powershell
   .\monitor-logs.ps1
   ```

2. Verify environment variables:
   - INSTAGRAM_BOT_USERNAME
   - INSTAGRAM_BOT_PASSWORD
   
3. Run the bot manually to test:
   ```powershell
   .\start-instagram-bot.bat
   ```

4. Common fixes:
   - Run setup-scheduler.ps1 as Administrator
   - Ensure all TypeScript files are compiled
   - Check if npm dependencies are installed
   - Verify working directory in Task Scheduler

## Project Structure

- **src/client**: Contains the main logic for interacting with social media platforms like Instagram.
- **src/config**: Configuration files, including the logger setup.
- **src/utils**: Utility functions for handling errors, cookies, data saving, etc.
- **src/Agent**: Contains the AI agent logic and training scripts.
- **src/Agent/training**: Training scripts for the AI agent.
- **src/schema**: Schema definitions for AI-generated content and database models.
- **src/test**: Contains test data and scripts, such as example tweets.

## Logging

The project uses a custom logger to log information, warnings, and errors. Logs are saved in the [logs](http://_vscodecontentref_/3) directory.

## Error Handling

Process-level error handlers are set up to catch unhandled promise rejections, uncaught exceptions, and process warnings. Errors are logged using the custom logger.

## Scheduler Documentation

### Prerequisites

1. Node.js (v14 or higher)
2. npm (comes with Node.js)
3. PM2 (install globally with `npm install -g pm2`)
4. TypeScript (install globally with `npm install -g typescript`)

### Configuration

#### Environment Variables (.env)

```env
# Web Server Configuration
WEB_SERVER_ENABLED=false
PORT=3000

# Instagram Credentials
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password

# Bot Configuration
MAX_DAILY_INTERACTIONS=100
INTERACTION_RESET_HOUR=0

# MongoDB Configuration
MONGODB_URI=your_mongodb_connection_string

# Gemini API Keys (for AI functionality)
GEMINI_API_KEY_1=your_gemini_api_key
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the TypeScript files:
   ```bash
   tsc
   ```

## Running the Application

#### Using PM2 (Recommended)

The application is configured to run using PM2, which provides process management and auto-restart capabilities.

##### Start the Application
```bash
pm2 start ecosystem.config.js
```

##### View Logs
```bash
pm2 logs instagram-scheduler
```

##### Restart the Application
```bash
pm2 restart instagram-scheduler
```

##### Stop the Application
```bash
pm2 stop instagram-scheduler
```

##### Delete from PM2
```bash
pm2 delete instagram-scheduler
```

### Schedule Configuration

The agent is configured to run every 20 minutes. To modify the schedule, edit the `schedule` variable in `src/scheduler.ts`:

```typescript
const schedule = '*/20 * * * *';  // Runs every 20 minutes
```

Common cron patterns:
- Every 30 minutes: `*/30 * * * *`
- Every hour: `0 * * * *`
- Every 2 hours: `0 */2 * * *`
- Every day at midnight: `0 0 * * *`

### Error Handling

The application will automatically retry after 5 minutes if an error occurs. This can be adjusted by modifying the `RETRY_DELAY` constant in `src/scheduler.ts`.

## Automatic Startup

A PowerShell script (`start-agent.ps1`) is provided to automatically start the agent. You can:

1. Run it manually
2. Create a shortcut in your Windows Startup folder
3. Create a scheduled task to run it on system startup

## Monitoring

You can monitor the application using PM2's web interface:

```bash
pm2 plus
```

This provides:
- Real-time metrics
- Log viewing
- Process management
- Email notifications for errors

## Troubleshooting

1. If the agent crashes:
   - Check the logs: `pm2 logs instagram-scheduler`
   - Verify your .env configuration
   - Ensure MongoDB is accessible
   - Check your Instagram credentials

2. If the schedule isn't working:
   - Verify the cron pattern in scheduler.ts
   - Check the system timezone
   - Ensure the PM2 process is running

3. If MongoDB isn't connecting:
   - Verify your connection string
   - Check network connectivity
   - Ensure MongoDB service is running

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Acknowledgements

- [Google Generative AI](https://ai.google/tools/) for providing the AI models.
- [Puppeteer](https://github.com/puppeteer/puppeteer) for browser automation.
- [puppeteer-extra](https://github.com/berstend/puppeteer-extra) for additional plugins and enhancements.

## Instagram Agent 24/7 Operation Guide

This guide explains how to set up and run the Instagram AI Agent continuously using PM2 process manager.

### Table of Contents
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running 24/7](#running-24/7)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

### Prerequisites

1. Node.js (v14 or higher)
2. npm (comes with Node.js)
3. PM2 (install globally):
   ```bash
   npm install -g pm2
   ```
4. TypeScript (install globally):
   ```bash
   npm install -g typescript
   ```

### Installation

1. Clone the repository:
   ```bash
   git clone [your-repo-url]
   cd instagram-agent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the TypeScript files:
   ```bash
   tsc
   ```

### Configuration

#### 1. Environment Variables (.env)

Create a `.env` file with your credentials:

```env
# Instagram Account
IG_USERNAME_1=your_instagram_username
IG_PASSWORD_1=your_instagram_password

# OpenAI API Key (required for AI comments)
OPENAI_API_KEY=your_openai_api_key

# Proxy Configuration
INSTAGRAM_PROXY_PORT=9000

# Other Settings
MAX_DAILY_INTERACTIONS=100
INTERACTION_RESET_HOUR=0
```

#### 2. Schedule Configuration

The agent is configured to run every 20 minutes. To modify this, edit `src/scheduler.ts`:

```typescript
// Run every 20 minutes
const schedule = '*/20 * * * *';
```

Common schedule patterns:
- Every 30 minutes: `*/30 * * * *`
- Every hour: `0 * * * *`
- Every 2 hours: `0 */2 * * *`
- Every day at midnight: `0 0 * * *`

### Running 24/7

#### Method 1: Using PM2 (Recommended)

1. Start the agent with PM2:
   ```bash
   pm2 start ecosystem.config.js
   ```

2. Save the PM2 process list:
   ```bash
   pm2 save
   ```

3. Set up PM2 to start on system boot:
   ```bash
   pm2 startup
   ```

#### Method 2: Using Windows Task Scheduler

1. Run the provided PowerShell script:
   ```powershell
   .\start-agent.ps1
   ```

2. Or create a scheduled task:
   ```powershell
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\start-agent.ps1`""
   $trigger = New-ScheduledTaskTrigger -AtStartup
   Register-ScheduledTask -TaskName 'Instagram Agent Startup' -Action $action -Trigger $trigger -RunLevel Highest -User $env:USERNAME
   ```

### Monitoring

#### Real-time Monitoring

1. View logs in real-time:
   ```bash
   pm2 logs instagram-scheduler
   ```

2. Monitor process status:
   ```bash
   pm2 monit
   ```

3. List all processes:
   ```bash
   pm2 list
   ```

#### Process Management

1. Restart the agent:
   ```bash
   pm2 restart instagram-scheduler
   ```

2. Stop the agent:
   ```bash
   pm2 stop instagram-scheduler
   ```

3. Delete the process:
   ```bash
   pm2 delete instagram-scheduler
   ```

### Troubleshooting

#### Common Issues

1. **Agent Crashes**
   - Check logs: `pm2 logs instagram-scheduler`
   - Verify Instagram credentials in `.env`
   - Check MongoDB connection
   - Ensure Gemini API key is valid

2. **Schedule Not Working**
   - Verify cron pattern in `scheduler.ts`
   - Check system timezone
   - Ensure PM2 is running: `pm2 list`

3. **MongoDB Connection Issues**
   - Check connection string in `.env`
   - Verify network connectivity
   - Ensure MongoDB service is running

4. **Process Not Starting on Boot**
   - Run `pm2 save` after any process changes
   - Re-run `pm2 startup`
   - Check Windows Task Scheduler

### Error Recovery

1. If the agent crashes:
   ```bash
   pm2 restart instagram-scheduler
   ```

2. If PM2 isn't working:
   ```bash
   pm2 kill
   pm2 start ecosystem.config.js
   ```

3. Complete reset:
   ```bash
   pm2 delete all
   pm2 kill
   pm2 start ecosystem.config.js
   pm2 save
   ```

### Maintenance

#### Regular Maintenance Tasks

1. Check logs daily:
   ```bash
   pm2 logs instagram-scheduler --lines 100
   ```

2. Monitor memory usage:
   ```bash
   pm2 monit
   ```

3. Update dependencies:
   ```bash
   npm update
   ```

4. Rebuild after changes:
   ```bash
   tsc
   pm2 restart instagram-scheduler
   ```

#### Best Practices

1. Regularly check logs for errors
2. Monitor Instagram rate limits
3. Keep dependencies updated
4. Back up your `.env` file
5. Monitor disk space and memory usage

### Support

For issues or questions:
1. Check the logs using `pm2 logs instagram-scheduler`
2. Review the configuration in `.env`
3. Verify all dependencies are installed
4. Check MongoDB connection
5. Monitor Instagram API status

## Instagram AI Agent - User Guide 🤖

This guide will help you set up and run the Instagram AI Agent, which automatically interacts with Instagram posts using AI-generated comments.

## Quick Start Guide for Non-Experts 🚀

### One-Time Setup

1. **Install Required Software**:
   - Download and install [Node.js](https://nodejs.org/) (LTS version)
   - Download and install [Git](https://git-scm.com/downloads)
   - After installation, open PowerShell or Command Prompt and run:
     ```sh
     npm install -g pm2
     npm install -g typescript
     ```

2. **Get the Code**:
   - Create a folder where you want to store the app
   - Open PowerShell in that folder
   - Run these commands:
     ```sh
     git clone https://github.com/david-patrick-chuks/Riona-AI-Agent.git
     cd Riona-AI-Agent
     npm install
     ```

3. **Set Up Your Configuration**:
   - Find the `.env.example` file in the project folder
   - Make a copy and rename it to `.env`
   - Open `.env` and fill in your details:
     ```env
     # Instagram Account
     IG_USERNAME_1=your_instagram_username
     IG_PASSWORD_1=your_instagram_password

     # OpenAI API Key (required for AI comments)
     OPENAI_API_KEY=your_openai_api_key

     # Proxy Configuration
     INSTAGRAM_PROXY_PORT=9000

     # Other Settings
     MAX_DAILY_INTERACTIONS=100
     INTERACTION_RESET_HOUR=0
     ```

### Running the App 🏃‍♂️

1. **Start the App**:
   - Open PowerShell in your project folder
   - Run these commands in order:
     ```sh
     npm run build
     pm2 start ecosystem.config.js
     ```

2. **Check if it's Running**:
   - To see the app status:
     ```sh
     pm2 status
     ```
   - To see the logs:
     ```sh
     pm2 logs
     ```

3. **Stop the App**:
   - When you want to stop:
     ```sh
     pm2 delete all
     ```

### What to Expect 👀

- The app will run every 20 minutes
- Each run will:
  1. Open a browser window
  2. Log into your Instagram account
  3. Scroll through posts
  4. Like and comment on posts
  5. Close the browser
- You can watch the process in the logs

### Troubleshooting 🔧

If you see errors:

1. **"Instagram credentials not found"**:
   - Check your `.env` file
   - Make sure IG_USERNAME_1 and IG_PASSWORD_1 are correct

2. **"OpenAI API key not found"**:
   - Get an API key from [OpenAI](https://platform.openai.com/)
   - Add it to your `.env` file

3. **Browser/Proxy Issues**:
   - Run `pm2 delete all`
   - Wait 1 minute
   - Run `pm2 start ecosystem.config.js`

4. **Other Issues**:
   - Check the logs: `pm2 logs`
   - Stop all: `pm2 delete all`
   - Restart your computer
   - Start again: `pm2 start ecosystem.config.js`

### Safety Tips 🛡️

1. **Account Security**:
   - Use a strong Instagram password
   - Don't share your `.env` file
   - Monitor your Instagram activity

2. **Usage Limits**:
   - The app is set to safe limits by default
   - Don't modify timing settings unless you know what you're doing
   - Monitor your account for any warnings from Instagram

### Getting Help 🆘

If you need help:
1. Check the logs: `pm2 logs`
2. Look for error messages
3. Google the error message
4. Ask for help in the project's issues section

## Advanced Settings (Optional) ⚙️

### Customize Interaction Frequency:
Edit `ecosystem.config.js`:
- Change schedule timing
- Adjust interaction limits
- Modify wait times

### Customize AI Responses:
Edit `src/Agent/index.ts`:
- Modify the prompt
- Adjust response length
- Change AI temperature

Remember: The default settings are optimized for safety and natural behavior. Only change them if you understand the implications.

## Maintenance 🔄

Regular maintenance tasks:
1. Check logs weekly: `pm2 logs`
2. Update the app monthly:
   ```sh
   git pull
   npm install
   npm run build
   pm2 restart all
   ```
3. Monitor your Instagram account for any warnings

## Need More Help? 📞

- Create an issue on GitHub
- Check the detailed documentation
- Join our community discussions

Remember: This is an automation tool. Use it responsibly and within Instagram's terms of service.
