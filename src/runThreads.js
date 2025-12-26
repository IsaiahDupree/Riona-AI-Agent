const ThreadsAgent = require('./threadsAgent');
const logger = require('./config/logger').default;

async function main() {
    // Accept JSON input from command line (for Python integration)
    const arg = process.argv[2];
    if (arg) {
        try {
            const input = JSON.parse(arg);
            // Echo back the received input for testing
            console.log(JSON.stringify({ status: 'received', input }));
            return;
        } catch (e) {
            console.error('Invalid JSON input:', e);
            process.exit(1);
        }
    }
    // Default workflow if no input
    const agent = new ThreadsAgent();
    try {
        await agent.initialize();  // initialize already handles login
        // Interact with posts from the main feed
        await agent.interactWithFeedPosts(2); // Interact with 2 posts
        logger.info('Threads interactions completed successfully');
    } catch (error) {
        logger.error('Error running Threads agent:', error);
        throw error;
    } finally {
        await agent.cleanup();
    }
}

main().catch(console.error);
