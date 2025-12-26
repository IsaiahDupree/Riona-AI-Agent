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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const dotenv_1 = __importDefault(require("dotenv"));
const helmet_1 = __importDefault(require("helmet")); // For securing HTTP headers
const logger_1 = __importStar(require("./config/logger"));
const utils_1 = require("./utils");
const db_1 = require("./config/db");
// Set up process-level error handlers
(0, logger_1.setupErrorHandlers)();
// Initialize environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
// Connect to the database
(0, db_1.connectDB)();
// Middleware setup
app.use((0, helmet_1.default)({ xssFilter: true, noSniff: true })); // Security headers
app.use(express_1.default.json()); // JSON body parsing
app.use(express_1.default.urlencoded({ extended: true, limit: '1kb' })); // URL-encoded data
app.use((0, cookie_parser_1.default)()); // Cookie parsing
const runAgents = async () => {
    let threadsAgent = null;
    
    try {
        logger_1.default.info("Starting Threads agent...");
        const ThreadsAgent = require("./threadsAgent");
        
        threadsAgent = new ThreadsAgent({});
        await threadsAgent.initialize();
        await threadsAgent.login();
        
        // Example interaction (commented out for safety)
        // await threadsAgent.post("Hello from Threads Agent!");
        
        logger_1.default.info("Threads agent finished.");
    } catch (error) {
        logger_1.default.error("Error running Threads agent:", error.message);
        throw error; // Propagate error for global error handler
    } finally {
        if (threadsAgent) {
            try {
                await threadsAgent.cleanup();
            } catch (cleanupError) {
                logger_1.default.error("Error during cleanup:", cleanupError.message);
            }
        }
    }
};
runAgents().catch(error => {
    (0, utils_1.setup_HandleError)(error, "Error running agents:");
});
exports.default = app;
//# sourceMappingURL=app.js.map
