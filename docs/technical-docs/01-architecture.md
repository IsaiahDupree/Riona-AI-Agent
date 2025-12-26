# System Architecture

## Core Components

The Instagram Bot is built with a modular architecture consisting of several key components:

### 1. Instagram-Core.ts
The core engine that handles all Instagram interactions. Key responsibilities:

```typescript
// Core interaction types
interface BotInteraction {
    timestamp: Date;
    type: 'comment' | 'like';
    success: boolean;
    error?: string;
    details?: string;
    metadata?: any;
}

// Main processing functions
async function processPostWithRetry(post: ElementHandle<Element>, page: Page, retryCount = 0): Promise<ProcessPostResult>
async function processPosts(posts: ElementHandle<Element>[], page: Page): Promise<void>
```

### 2. Comment Generation System
Handles AI-powered comment generation and validation:

```typescript
// Comment generation interface
interface CommentGuidelines {
    minLength: number;
    maxLength: number;
    maxEmojis: number;
    forbiddenPhrases: string[];
    spamPatterns: RegExp[];
    mustIncludeEmoji: boolean;
    mustAddValue: boolean;
    mustBeRelevant: boolean;
    maxPunctuation: number;
    maxCapitalizedWords: number;
}

// Generation and validation functions
async function generateComment(caption: string): Promise<string | null>
async function validateComment(comment: string, guidelines: CommentGuidelines): Promise<boolean>
```

### 3. Browser Automation Layer
Manages Puppeteer interactions and simulates human behavior:

```typescript
// Browser interaction functions
async function clickWithPrecision(page: Page, element: ElementHandle<Element>): Promise<boolean>
async function postComment(post: ElementHandle<Element>, page: Page, comment: string): Promise<{ success: boolean; error?: string }>
async function likePost(post: ElementHandle<Element>, page: Page): Promise<boolean>
```

### 4. Data Management
Handles data persistence and logging:

```typescript
// Database interfaces
interface PostMetadata {
    username: string;
    caption: string;
    isVideo: boolean;
    hashtags: string[];
    timestamp: Date;
    type: 'post';
    likes: number;
}

// Database functions
async function initMongoDBConnection(): Promise<void>
async function saveInteractionToDb(interaction: BotInteraction): Promise<void>
```

## Data Flow

1. **Post Discovery**
   ```mermaid
   graph LR
   A[Home Feed] --> B[Post Discovery]
   B --> C[Content Analysis]
   C --> D[Interaction Decision]
   D --> E[Like/Comment Actions]
   E --> F[Database Storage]
   ```

2. **Comment Generation Flow**
   ```mermaid
   graph TD
   A[Caption Analysis] --> B[OpenAI API]
   B --> C[Comment Generation]
   C --> D[Validation]
   D --> E[Posting]
   E --> F[Verification]
   ```

## Integration Points

### 1. OpenAI Integration
```typescript
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Comment generation using OpenAI
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
```

### 2. MongoDB Integration
```typescript
// MongoDB connection
const mongoClient = new MongoClient(process.env.MONGODB_URI);
await mongoClient.connect();
const db = mongoClient.db('instagram_bot');
const postsCollection = db.collection('posts');
const interactionsCollection = db.collection('interactions');
```

### 3. Browser Automation
```typescript
// Puppeteer setup
const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
});
const page = await browser.newPage();
```

## Error Handling Strategy

The system implements a comprehensive error handling strategy:

1. **Retry Mechanism**
   ```typescript
   async function processPostWithRetry(post: ElementHandle<Element>, page: Page, retryCount = 0)
   ```

2. **Logging System**
   ```typescript
   logger.error('Error during operation:', {
       error: error instanceof Error ? error.message : String(error),
       component: 'Instagram-Core',
       event: 'operation_error'
   });
   ```

3. **Validation Checks**
   ```typescript
   // Multiple verification methods for actions
   const verificationMethods = [
       async () => { /* Method 1 */ },
       async () => { /* Method 2 */ },
       async () => { /* Method 3 */ }
   ];
   ```

## Performance Considerations

1. **Rate Limiting**
   - Random delays between actions
   - Configurable interaction limits
   - Session-based tracking

2. **Resource Management**
   - Browser session management
   - Database connection pooling
   - Memory usage optimization

3. **Scalability**
   - Modular architecture
   - Asynchronous operations
   - Batch processing capabilities
