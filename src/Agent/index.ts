import { chatCompletion } from '../utils/ai';
import logger from "../config/logger";
import { InstagramCommentSchema } from "./schema";

export async function runAgent(prompt: string): Promise<InstagramCommentSchema> {
    try {
        logger.info("Generating content with Claude...");
        const raw = await chatCompletion({
            messages: [
                {
                    role: "system",
                    content: `You are an Instagram engagement expert. Your responses should be natural, engaging, and relevant to the post content. Always respond in JSON format matching this schema:
                    {
                        "comment": string,
                        "sentiment": "positive" | "neutral" | "negative",
                        "relevance": number (0-10),
                        "emojis": string[],
                        "hashtags": string[]
                    }
                    Reply with ONLY valid JSON, no other text.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 150
        });

        if (!raw) {
            logger.error("No response received from Claude");
            return {
                comment: "Error: No response from AI",
                sentiment: "neutral",
                relevance: 0,
                emojis: [],
                hashtags: []
            };
        }

        const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
        const response = JSON.parse(cleaned);
        logger.info("Content generated successfully");
        return response;

    } catch (error) {
        logger.error("Error generating content with Claude:", error);
        return {
            comment: "Error: Failed to generate comment",
            sentiment: "neutral",
            relevance: 0,
            emojis: [],
            hashtags: []
        };
    }
}
