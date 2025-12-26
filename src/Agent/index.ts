import { OpenAI } from 'openai';
import logger from "../config/logger";
import { InstagramCommentSchema } from "./schema";

export async function runAgent(prompt: string): Promise<InstagramCommentSchema> {
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
        logger.error("No OpenAI API key found in environment variables.");
        return {
            comment: "Error: No API key available",
            sentiment: "neutral",
            relevance: 0,
            emojis: [],
            hashtags: []
        };
    }

    try {
        const openai = new OpenAI({
            apiKey: openaiApiKey,
        });

        logger.info("Generating content with OpenAI...");
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
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
                    }`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0.7,
            max_tokens: 150
        });

        if (!completion.choices[0]?.message?.content) {
            logger.error("No response received from OpenAI");
            return {
                comment: "Error: No response from AI",
                sentiment: "neutral",
                relevance: 0,
                emojis: [],
                hashtags: []
            };
        }

        const response = JSON.parse(completion.choices[0].message.content);
        logger.info("Content generated successfully");
        return response;

    } catch (error) {
        logger.error("Error generating content with OpenAI:", error);
        return {
            comment: "Error: Failed to generate comment",
            sentiment: "neutral",
            relevance: 0,
            emojis: [],
            hashtags: []
        };
    }
}
