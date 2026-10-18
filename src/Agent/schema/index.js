"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstagramCommentSchema = void 0;
const generative_ai_1 = require("@google/generative-ai");
const mongoose_1 = __importStar(require("mongoose"));
const getInstagramCommentSchema = () => {
    return {
        description: `Lists comments that are engaging and have the potential to attract more likes and go viral.`,
        type: generative_ai_1.SchemaType.ARRAY,
        items: {
            type: generative_ai_1.SchemaType.OBJECT,
            properties: {
                comment: {
                    type: generative_ai_1.SchemaType.STRING,
                    description: "A comment between 150 and 250 characters.",
                    nullable: false,
                },
                viralRate: {
                    type: generative_ai_1.SchemaType.NUMBER,
                    description: "The viral rate, measured on a scale of 0 to 100.",
                    nullable: false,
                },
                commentTokenCount: {
                    type: generative_ai_1.SchemaType.NUMBER,
                    description: "The total number of tokens in the comment.",
                    nullable: false,
                },
            },
            required: [
                "comment",
                "viralRate",
                "commentTokenCount"
            ],
        },
    };
};
exports.getInstagramCommentSchema = getInstagramCommentSchema;
// Define the schema for the Tweet document
const tweetSchema = new mongoose_1.Schema({
    tweetContent: { type: String, required: true },
    imageUrl: { type: String, required: true },
    timeTweeted: { type: Date, default: Date.now },
});
// Create the model for the Tweet document
const Tweet = mongoose_1.default.model('Tweet', tweetSchema);
exports.default = Tweet;
