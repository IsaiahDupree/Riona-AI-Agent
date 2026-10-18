import { SchemaType } from "@google/generative-ai";
import mongoose, { Document, Schema, Model } from 'mongoose';

export interface InstagramCommentSchema {
    description: string;
    type: SchemaType;
    items: {
        type: SchemaType;
        properties: {
            comment: {
                type: SchemaType;
                description: string;
                nullable: boolean;
            };
            viralRate: {
                type: SchemaType;
                description: string;
                nullable: boolean;
            };
            commentTokenCount: {
                type: SchemaType;
                description: string;
                nullable: boolean;
            };
        };
    };
}

export function getInstagramCommentSchema(): InstagramCommentSchema {
    return {
        description: "An array of Instagram comments with their viral rates",
        type: SchemaType.ARRAY,
        items: {
            type: SchemaType.OBJECT,
            properties: {
                comment: {
                    type: SchemaType.STRING,
                    description: "A viral Instagram comment that would get a lot of likes and engagement",
                    nullable: false,
                },
                viralRate: {
                    type: SchemaType.NUMBER,
                    description: "A score from 0-100 indicating how viral this comment is likely to be",
                    nullable: false,
                },
                commentTokenCount: {
                    type: SchemaType.NUMBER,
                    description: "The number of tokens in the comment",
                    nullable: false,
                },
            },
        },
    };
}