# AI Integration

## OpenAI Integration

The Instagram bot leverages OpenAI's GPT models for intelligent content generation and analysis.

### Configuration

```typescript
// OpenAI client setup
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_ORG_ID // Optional
});

// Default model configuration
const DEFAULT_MODEL_CONFIG = {
    model: "gpt-3.5-turbo",
    temperature: 0.7,
    max_tokens: 60,
    presence_penalty: 0.6,
    frequency_penalty: 0.5
};
```

## Comment Generation Models

### System Prompts

```typescript
// Base system prompts for different interaction types
const SYSTEM_PROMPTS = {
    casual_comment: `You are a casual Instagram user who leaves simple, friendly comments.
        Your comments should be:
        1. Natural and conversational
        2. Positive and engaging
        3. Relevant to the content
        4. Appropriate for social media
        5. Include occasional emojis naturally`,
        
    engaging_comment: `You are an engaging Instagram user who provides thoughtful responses.
        Your comments should:
        1. Add value to the conversation
        2. Show genuine interest
        3. Ask relevant questions
        4. Encourage further interaction
        5. Maintain a professional yet friendly tone`
};

// Comment generation implementation
async function generateComment(caption: string, style: 'casual' | 'engaging' = 'casual'): Promise<string | null> {
    try {
        const systemPrompt = SYSTEM_PROMPTS[`${style}_comment`];
        
        const completion = await openai.chat.completions.create({
            ...DEFAULT_MODEL_CONFIG,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: `Generate a ${style} comment for this Instagram post: "${caption}"`
                }
            ]
        });

        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
        logger.error('Error in comment generation:', error);
        return null;
    }
}
```

### Comment Enhancement

```typescript
// Enhance comments with contextual awareness
async function enhanceComment(comment: string, context: {
    postType: 'photo' | 'video' | 'carousel',
    userFollowers: number,
    isVerified: boolean,
    previousInteractions: number
}): Promise<string> {
    const prompt = `
        Original comment: "${comment}"
        Post type: ${context.postType}
        User status: ${context.isVerified ? 'Verified' : 'Regular'} user with ${context.userFollowers} followers
        Previous interactions: ${context.previousInteractions}
        
        Enhance this comment to be more:
        1. Personalized to the user's status
        2. Appropriate for the content type
        3. Reflective of the relationship level
        4. Natural and engaging
    `;

    const completion = await openai.chat.completions.create({
        ...DEFAULT_MODEL_CONFIG,
        messages: [
            {
                role: "system",
                content: SYSTEM_PROMPTS.engaging_comment
            },
            {
                role: "user",
                content: prompt
            }
        ]
    });

    return completion.choices[0]?.message?.content?.trim() || comment;
}
```

## Content Analysis

### Caption Analysis

```typescript
// Analyze post captions for content understanding
async function analyzeCaption(caption: string): Promise<{
    topics: string[];
    sentiment: 'positive' | 'neutral' | 'negative';
    engagement_potential: number;
    suggested_response_type: 'casual' | 'engaging' | 'professional';
}> {
    const completion = await openai.chat.completions.create({
        ...DEFAULT_MODEL_CONFIG,
        messages: [
            {
                role: "system",
                content: `Analyze Instagram captions for key information.
                    Return a JSON object with:
                    - Main topics discussed
                    - Overall sentiment
                    - Engagement potential (0-1)
                    - Suggested response type`
            },
            {
                role: "user",
                content: `Analyze this caption: "${caption}"`
            }
        ]
    });

    return JSON.parse(completion.choices[0]?.message?.content || '{}');
}
```

### Interaction Strategy

```typescript
// Determine optimal interaction strategy
async function determineInteractionStrategy(
    postData: PostMetadata,
    userHistory: UserInteractionHistory
): Promise<InteractionStrategy> {
    const prompt = `
        Analyze this Instagram post and user history to determine the best interaction strategy.
        
        Post Data:
        - Caption: "${postData.caption}"
        - Media Type: ${postData.isVideo ? 'Video' : 'Photo'}
        - Engagement: ${postData.likes} likes
        
        User History:
        - Previous Interactions: ${userHistory.interactionCount}
        - Last Interaction: ${userHistory.lastInteraction}
        - Response Rate: ${userHistory.responseRate}
        
        Determine:
        1. Should we interact with this post?
        2. What type of interaction is most appropriate?
        3. What should be the engagement level?
        4. Are there any risks to consider?
    `;

    const completion = await openai.chat.completions.create({
        ...DEFAULT_MODEL_CONFIG,
        messages: [
            {
                role: "system",
                content: "You are an AI social media strategist determining optimal interaction patterns."
            },
            {
                role: "user",
                content: prompt
            }
        ]
    });

    return JSON.parse(completion.choices[0]?.message?.content || '{}');
}
```

## Error Handling and Validation

### Comment Validation

```typescript
// Validate generated comments using AI
async function validateGeneratedComment(
    comment: string,
    context: ValidationContext
): Promise<ValidationResult> {
    const prompt = `
        Validate this Instagram comment for appropriateness and quality:
        Comment: "${comment}"
        
        Context:
        - Post Type: ${context.postType}
        - Target Audience: ${context.audience}
        - Previous Interaction Level: ${context.interactionLevel}
        
        Check for:
        1. Appropriate tone and language
        2. Relevant content
        3. Natural flow
        4. Proper emoji usage
        5. Potential red flags
    `;

    const completion = await openai.chat.completions.create({
        ...DEFAULT_MODEL_CONFIG,
        messages: [
            {
                role: "system",
                content: "You are a content moderator ensuring high-quality social media interactions."
            },
            {
                role: "user",
                content: prompt
            }
        ]
    });

    return JSON.parse(completion.choices[0]?.message?.content || '{}');
}
```

## Performance Optimization

### Rate Limiting and Caching

```typescript
// Implement rate limiting for API calls
class AIRateLimiter {
    private requestQueue: Array<() => Promise<any>> = [];
    private isProcessing = false;
    private lastRequestTime = 0;
    private readonly minDelay = 1000; // Minimum delay between requests

    async addRequest<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            
            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    private async processQueue() {
        if (this.requestQueue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minDelay) {
            await delay(this.minDelay - timeSinceLastRequest);
        }

        const request = this.requestQueue.shift();
        if (request) {
            this.lastRequestTime = Date.now();
            await request();
        }

        this.processQueue();
    }
}
```
