"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const logger_1 = __importDefault(require("./logger"));
const connectDB = async () => {
    try {
        await mongoose_1.default.connect(process.env.MONGODB_URI || '', {
        // These options are no longer necessary
        });
        logger_1.default.info('MongoDB connected');
    }
    catch (error) {
        logger_1.default.error('MongoDB connection error:', error);
        process.exit(1);
    }
};
exports.connectDB = connectDB;
