import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const ARTIFACTS_DIR = process.env.ARTIFACT_BASE_PATH || './artifacts';

export function ensureArtifactsDir(runId: string): string {
  const runDir = path.join(ARTIFACTS_DIR, runId);
  
  try {
    if (!fs.existsSync(ARTIFACTS_DIR)) {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    }
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
  } catch (error) {
    logger.error(`Failed to create artifacts directory: ${runDir}`, error);
  }
  
  return runDir;
}

export async function saveScreenshot(runId: string, name: string, buffer: Buffer): Promise<string> {
  const runDir = ensureArtifactsDir(runId);
  const filepath = path.join(runDir, `${name}.png`);
  
  try {
    fs.writeFileSync(filepath, buffer);
    logger.info(`Screenshot saved: ${filepath}`);
    return filepath;
  } catch (error) {
    logger.error(`Failed to save screenshot: ${filepath}`, error);
    throw error;
  }
}

export async function saveTextArtifact(runId: string, name: string, content: string): Promise<string> {
  const runDir = ensureArtifactsDir(runId);
  const filepath = path.join(runDir, `${name}.txt`);
  
  try {
    fs.writeFileSync(filepath, content, 'utf8');
    logger.info(`Text artifact saved: ${filepath}`);
    return filepath;
  } catch (error) {
    logger.error(`Failed to save text artifact: ${filepath}`, error);
    throw error;
  }
}

export async function saveJsonArtifact(runId: string, name: string, data: any): Promise<string> {
  const runDir = ensureArtifactsDir(runId);
  const filepath = path.join(runDir, `${name}.json`);
  
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`JSON artifact saved: ${filepath}`);
    return filepath;
  } catch (error) {
    logger.error(`Failed to save JSON artifact: ${filepath}`, error);
    throw error;
  }
}

export function getArtifactUrl(runId: string, filename: string): string {
  const baseUrl = process.env.ARTIFACT_BASE_URL || '/artifacts';
  return `${baseUrl}/${runId}/${encodeURIComponent(filename)}`;
}

export function listArtifacts(runId: string): Array<{ name: string; url: string; size: number; modified: Date }> {
  const runDir = path.join(ARTIFACTS_DIR, runId);
  
  try {
    if (!fs.existsSync(runDir)) {
      return [];
    }
    
    const files = fs.readdirSync(runDir);
    return files.map(filename => {
      const filepath = path.join(runDir, filename);
      const stats = fs.statSync(filepath);
      return {
        name: filename,
        url: getArtifactUrl(runId, filename),
        size: stats.size,
        modified: stats.mtime
      };
    });
  } catch (error) {
    logger.error(`Failed to list artifacts for run: ${runId}`, error);
    return [];
  }
}
