"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIAudioFileService = void 0;
const generative_ai_1 = require("@google/generative-ai");
const server_1 = require("@google/generative-ai/server");
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
dotenv_1.default.config();
const apiKey = process.env.GEMINI_API_KEY_41;
if (!apiKey) {
    throw new Error("API key is missing");
}
class AIAudioFileService {
    fileManager;
    genAI;
    constructor() {
        this.fileManager = new server_1.GoogleAIFileManager(apiKey);
        this.genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
    }
    /**
     * Uploads the files to Google AIFileManager, i.e a 48 hours temp storage.
     * @param filePath - The local path of the file to upload.
     * @param displayName - The display name for the uploaded file.
     * @param mimeType - The MIME type of the file.
     */
    async processFile(filePath, displayName, mimeType) {
        try {
            const uploadResult = await this.fileManager.uploadFile(filePath, {
                mimeType,
                displayName,
            });
            let file = await this.fileManager.getFile(uploadResult.file.name);
            // Wait for the file to be processed
            while (file.state === server_1.FileState.PROCESSING) {
                process.stdout.write(".");
                await new Promise((resolve) => setTimeout(resolve, 10_000));
                file = await this.fileManager.getFile(uploadResult.file.name);
            }
            if (file.state === server_1.FileState.FAILED) {
                throw new Error("File processing failed.");
            }
            // Generate content using Gemini
            const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent([
                "Tell me about this audio clip.",
                {
                    fileData: {
                        fileUri: uploadResult.file.uri,
                        mimeType: uploadResult.file.mimeType,
                    },
                },
            ]);
            // Delete the uploaded file from Google AI
            await this.fileManager.deleteFile(uploadResult.file.name);
            console.log(`Deleted ${uploadResult.file.displayName}`);
            return result.response.text();
        }
        catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error processing file: ${error.message}`);
            }
            else {
                throw new Error(`Unknown error occurred during file processing.`);
            }
        }
        finally {
            // Delete the temporary file from the local server
            if (fs_1.default.existsSync(filePath)) {
                fs_1.default.unlinkSync(filePath);
            }
        }
    }
}
exports.AIAudioFileService = AIAudioFileService;
