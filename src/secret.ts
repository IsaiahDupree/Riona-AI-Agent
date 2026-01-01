// API keys for Gemini - load from environment variables
// Add your Gemini API keys to .env file as GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.

export const geminiApiKeys: string[] = [
    process.env.GEMINI_API_KEY_1 || '',
    process.env.GEMINI_API_KEY_2 || '',
    process.env.GEMINI_API_KEY_3 || '',
].filter(key => key.length > 0);

// If no keys are configured, add a placeholder to prevent empty array issues
if (geminiApiKeys.length === 0) {
    geminiApiKeys.push(process.env.GEMINI_API_KEY || '');
}
