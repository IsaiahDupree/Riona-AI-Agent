# Core Features

## Post Discovery

The bot implements sophisticated post discovery mechanisms to find and interact with relevant content.

### Feed Processing
```typescript
async function processPosts(posts: ElementHandle<Element>[], page: Page): Promise<void> {
    for (const post of posts) {
        try {
            // Extract post metadata
            const metadata = await extractPostMetadata(post, page);
            
            // Process post with retry mechanism
            const result = await processPostWithRetry(post, page);
            
            // Save interaction to database
            await saveInteractionToDb({
                timestamp: new Date(),
                type: result.type,
                success: result.success,
                error: result.error,
                details: result.details,
                metadata: metadata
            });
        } catch (error) {
            logger.error('Error processing post:', error);
        }
    }
}
```

### Post Metadata Extraction
```typescript
async function extractPostMetadata(post: ElementHandle<Element>, page: Page): Promise<PostMetadata | null> {
    const username = await extractUsername(post);
    const caption = await extractCaption(post, page);
    const isVideo = await isVideoPost(post);
    const likes = await extractLikesCount(post);
    const hashtags = extractHashtags(caption);
    
    return {
        username,
        caption,
        isVideo,
        hashtags,
        likes,
        timestamp: new Date(),
        type: 'post',
        success: true
    };
}
```

## Like Functionality

The bot implements precise and human-like liking behavior.

### Like Implementation
```typescript
async function likePost(post: ElementHandle<Element>, page: Page): Promise<boolean> {
    try {
        // Check if already liked
        if (await hasAlreadyLiked(post, page)) {
            return true;
        }

        // Get like button
        const likeButton = await getLikeButton(post, page);
        if (!likeButton) {
            throw new Error('Like button not found');
        }

        // Click with precision
        const success = await clickWithPrecision(page, likeButton);
        if (!success) {
            throw new Error('Failed to click like button');
        }

        // Verify like action
        return await verifyLike(post, page);
    } catch (error) {
        logger.error('Error during like operation:', error);
        return false;
    }
}
```

## Comment Generation & Posting

Advanced AI-powered comment generation with natural language processing.

### Comment Generation
```typescript
async function generateComment(caption: string): Promise<string | null> {
    try {
        const prompt = `
            Post caption: "${caption}"
            Generate a natural, friendly comment that:
            1. Is relevant to the post content
            2. Shows genuine engagement
            3. Maintains a casual, positive tone
            4. May include 1-2 relevant emojis
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "You are a casual Instagram user who leaves simple, friendly comments."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 60,
            temperature: 0.7
        });

        const comment = completion.choices[0]?.message?.content?.trim();
        return comment || null;
    } catch (error) {
        logger.error('Error generating comment:', error);
        return null;
    }
}
```

### Comment Validation
```typescript
async function validateComment(comment: string, guidelines: CommentGuidelines = DEFAULT_COMMENT_GUIDELINES): Promise<boolean> {
    // Length validation
    if (comment.length < guidelines.minLength || comment.length > guidelines.maxLength) {
        return false;
    }

    // Emoji count
    const emojiCount = (comment.match(/[\p{Emoji}]/gu) || []).length;
    if (emojiCount > guidelines.maxEmojis) {
        return false;
    }

    // Forbidden phrases
    for (const phrase of guidelines.forbiddenPhrases) {
        if (comment.toLowerCase().includes(phrase.toLowerCase())) {
            return false;
        }
    }

    // Spam patterns
    for (const pattern of guidelines.spamPatterns) {
        if (pattern.test(comment)) {
            return false;
        }
    }

    // Additional checks
    const punctuationCount = (comment.match(/[!?.,;]/g) || []).length;
    if (punctuationCount > guidelines.maxPunctuation) {
        return false;
    }

    const capitalizedWords = comment.split(' ').filter(word => /^[A-Z][a-z]*$/.test(word));
    if (capitalizedWords.length > guidelines.maxCapitalizedWords) {
        return false;
    }

    return true;
}
```

### Comment Posting
```typescript
async function postComment(post: ElementHandle<Element>, page: Page, comment: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Find comment box using multiple selectors
        const commentSelectors = [
            'textarea[aria-label="Add a comment…"]',
            'textarea[placeholder="Add a comment..."]',
            'textarea[aria-label*="comment"]'
        ];

        let commentBox = null;
        for (const selector of commentSelectors) {
            commentBox = await post.$(selector);
            if (commentBox) break;
        }

        if (!commentBox) {
            throw new Error('Comment box not found');
        }

        // Type comment with human-like delays
        for (const char of comment) {
            await page.keyboard.type(char, { delay: Math.random() * 100 + 30 });
        }

        // Submit comment using Enter key
        await page.keyboard.press('Enter');
        await delay(2000);

        // Verify comment was posted
        return await verifyComment(page, post, comment);
    } catch (error) {
        return { success: false, error: String(error) };
    }
}
```

## Content Analysis

The bot includes sophisticated content analysis capabilities.

### Caption Analysis
```typescript
async function analyzeCaption(caption: string): Promise<{
    sentiment: string;
    topics: string[];
    language: string;
    engagement: number;
}> {
    // Implementation details for content analysis
    // This would typically involve NLP processing
    // and sentiment analysis
}
```

## Error Handling

Comprehensive error handling and recovery mechanisms.

### Retry Mechanism
```typescript
async function processPostWithRetry(
    post: ElementHandle<Element>, 
    page: Page, 
    retryCount = 0
): Promise<ProcessPostResult> {
    try {
        // Process post
        return await processPost(post, page);
    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            logger.warn(`Retrying post processing (attempt ${retryCount + 1})`);
            await delay(1000 * (retryCount + 1));
            return processPostWithRetry(post, page, retryCount + 1);
        }
        throw error;
    }
}
```

### Error Logging
```typescript
function logError(error: Error, context: string): void {
    logger.error(`Error in ${context}:`, {
        error: error.message,
        stack: error.stack,
        timestamp: new Date(),
        context
    });
}
```
