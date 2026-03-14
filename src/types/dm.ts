// ── Core DM Types ────────────────────────────────────────────────────

export interface DMMessage {
    sender: string;
    text: string;
    timestamp: string;
    isOurs: boolean;
    mediaType?: 'text' | 'image' | 'video' | 'voice' | 'link';
}

export interface ConversationPreview {
    username: string;
    lastMessage: string;
    lastMessageTime: string;
    unread: boolean;
    profilePicUrl?: string;
}

export interface DMSendResult {
    success: boolean;
    error?: string;
    recipientUsername: string;
    messageText: string;
    timestamp: string;
    verified: boolean;
}

// ── Tracking Types ───────────────────────────────────────────────────

export interface TrackedDM {
    recipientUsername: string;
    messageText: string;
    timestamp: string;
    direction: 'outbound' | 'inbound';
    verified: boolean;
    sessionId: string;
    conversationId: string;
    relationshipCategory?: string;
    approvalStatus?: 'auto' | 'manual_approved' | 'pending';
}

export interface DMSessionLog {
    sessionId: string;
    startTime: string;
    endTime?: string;
    messagesSent: number;
    messagesReceived: number;
    messagesVerified: number;
    messagesFailed: number;
    errors: string[];
    messages: TrackedDM[];
}

// ── Relationship & AI Context Types (Phase 2+) ─────────────────────

export interface ProfileInfo {
    username: string;
    fullName: string;
    bio: string;
    followerCount: number;
    followingCount: number;
    postCount: number;
    isVerified: boolean;
    niche?: string;
}

export interface RelationshipInfo {
    category: 'business_networking' | 'personal' | 'potential_client' | 'collaborator' | 'fan';
    warmth: number;             // 0-100
    stage: 'cold_outreach' | 'initial_contact' | 'building' | 'warm' | 'active';
    lastInteraction?: string;
    notes: string[];
    tags: string[];
}

export interface DMContext {
    ourProfile: ProfileInfo;
    theirProfile: ProfileInfo;
    conversationHistory: DMMessage[];
    relationship: RelationshipInfo;
    objective: string;
}

// ── Approval Flow Types (Phase 3+) ──────────────────────────────────

export interface DMApproval {
    id: string;
    recipientUsername: string;
    proposedMessage: string;
    context?: DMContext;
    status: 'pending' | 'approved' | 'rejected' | 'auto_approved';
    reviewedAt?: string;
}
