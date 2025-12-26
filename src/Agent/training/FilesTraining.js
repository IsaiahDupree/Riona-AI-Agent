"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFile = parseFile;
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const mammoth_1 = __importDefault(require("mammoth"));
const textract_1 = __importDefault(require("textract"));
const csv_parser_1 = __importDefault(require("csv-parser"));
const stream_1 = require("stream");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function parseFile(fileBuffer, fileType) {
    let content = '';
    if (fileType === 'pdf') {
        const data = await (0, pdf_parse_1.default)(fileBuffer);
        content = data.text;
    }
    else if (fileType === 'docx') {
        const result = await mammoth_1.default.extractRawText({ buffer: fileBuffer });
        content = result.value;
    }
    else if (fileType === 'doc') {
        content = await new Promise((resolve, reject) => {
            textract_1.default.fromBufferWithMime('application/msword', fileBuffer, (error, text) => {
                if (error)
                    reject(error);
                else
                    resolve(text);
            });
        });
    }
    else if (fileType === 'csv') {
        content = await new Promise((resolve, reject) => {
            const results = [];
            stream_1.Readable.from(fileBuffer)
                .pipe((0, csv_parser_1.default)())
                .on('data', (data) => results.push(JSON.stringify(data)))
                .on('end', () => resolve(results.join('\n')))
                .on('error', (err) => reject(err));
        });
    }
    else if (fileType === 'txt') {
        content = fileBuffer.toString('utf8');
    }
    else {
        throw new Error(`Unsupported file type: ${fileType}`);
    }
    return content;
}
async function testParse() {
    try {
        // Define the file path and type
        const filePath = path_1.default.join(__dirname, 'test.txt');
        const fileType = 'txt'; // Change to match your test file's format
        // Read the file into a buffer
        const fileBuffer = fs_1.default.readFileSync(filePath);
        // Call the parseFile function
        const content = await parseFile(fileBuffer, fileType);
        console.log('Parsed Content:', content);
    }
    catch (error) {
        console.error('Error parsing file:', error);
    }
}
// Execute the test function
testParse();
