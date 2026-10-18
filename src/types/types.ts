export interface PostData {
    id: string;
    caption: string;
    authorUsername: string;
    likes: number;
    comments: number;
    imageUrl?: string;
    videoUrl?: string;
    isVideo: boolean;
}

export interface PostInteraction {
    postId: string;
    timestamp: string;
    action: 'like' | 'comment';
    success: boolean;
    commentText?: string;
}

export interface InteractionResult {
    success: boolean;
    method: string;
    details: string;
}
