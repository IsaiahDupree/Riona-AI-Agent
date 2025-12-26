export interface InstagramCommentSchema {
    comment: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    relevance: number;
    emojis: string[];
    hashtags: string[];
}

const defaultComments = [
    "Love this! 💕",
    "Amazing shot! 📸",
    "This is awesome! ✨",
    "Great content! 🙌",
    "Beautiful! 😍",
    "Fantastic! 🌟",
    "This made my day! 🎉",
    "So cool! 🔥",
    "Perfect! ⭐",
    "Wonderful! 💫"
];

export function getInstagramCommentSchema(): InstagramCommentSchema {
    const randomComment = defaultComments[Math.floor(Math.random() * defaultComments.length)];
    
    return {
        comment: randomComment,
        sentiment: 'positive',
        relevance: 1,
        emojis: randomComment.match(/[\u{1F300}-\u{1F9FF}]/gu) || [],
        hashtags: []
    };
}

export default InstagramCommentSchema;
