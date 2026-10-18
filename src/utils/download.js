"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.download = void 0;
const fs_1 = __importDefault(require("fs"));
const request_1 = __importDefault(require("request"));
const logger_1 = __importDefault(require("../config/logger"));
const download = function (uri, filename, callback) {
    request_1.default.head(uri, function (err, _res, _body) {
        if (err) {
            logger_1.default.error(`Error fetching headers for ${uri}: ${err.message}`);
            callback(err);
            return;
        }
        (0, request_1.default)(uri)
            .pipe(fs_1.default.createWriteStream(filename))
            .on('error', (err) => {
            logger_1.default.error(`Error downloading file from ${uri}: ${err.message}`);
            callback(err);
        })
            .on('close', () => {
            logger_1.default.info(`File downloaded successfully from ${uri} to ${filename}`);
            callback();
        });
    });
};
exports.download = download;
