import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Security Tests', () => {
    describe('Dependency Audit', () => {
        it('should not have critical vulnerabilities', () => {
            try {
                const output = execSync('npm audit --json', { encoding: 'utf-8' });
                const audit = JSON.parse(output);
                const criticalVulns = audit.metadata?.vulnerabilities?.critical || 0;
                expect(criticalVulns).toBe(0);
            } catch (error: any) {
                // npm audit returns non-zero exit code if vulnerabilities exist
                if (error.stdout) {
                    const audit = JSON.parse(error.stdout);
                    const criticalVulns = audit.metadata?.vulnerabilities?.critical || 0;
                    expect(criticalVulns).toBe(0);
                }
            }
        });
    });

    describe('Secret Scanning', () => {
        it('should not have hardcoded secrets in source files', () => {
            const srcDir = path.join(process.cwd(), 'src');
            const files = getAllFiles(srcDir, ['.ts', '.js']);

            const secretPatterns = [
                /api[_-]?key\s*=\s*['"][^'"]{20,}['"]/i,
                /password\s*=\s*['"][^'"]+['"]/i,
                /secret\s*=\s*['"][^'"]{20,}['"]/i,
                /sk-[a-zA-Z0-9]{20,}/g, // OpenAI keys
            ];

            let foundSecrets = false;
            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8');
                for (const pattern of secretPatterns) {
                    if (pattern.test(content)) {
                        foundSecrets = true;
                        console.warn(`Potential secret found in ${file}`);
                    }
                }
            }

            expect(foundSecrets).toBe(false);
        });
    });
});

function getAllFiles(dir: string, extensions: string[]): string[] {
    const files: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...getAllFiles(fullPath, extensions));
        } else if (extensions.some(ext => item.endsWith(ext))) {
            files.push(fullPath);
        }
    }

    return files;
}
