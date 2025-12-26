import { BotInteraction } from '../client/Instagram-Core';

export interface GraphCredentials {
    instagram_business_id: string;
    facebook_page_id: string;
    access_token: string;
    token_expires_at: Date;
    graph_api_enabled: boolean;
}

export interface StorageInterface {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    saveInteraction(interaction: BotInteraction): Promise<void>;
    getInteractions(filter: any): Promise<BotInteraction[]>;
}
