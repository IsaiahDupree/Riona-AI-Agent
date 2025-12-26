export function getValidatedUsername(): string | undefined {
    const username = process.env.INSTAGRAM_BOT_USERNAME;
    if (!username) {
        console.warn('No username found in environment variables');
        return undefined;
    }
    return username;
}
