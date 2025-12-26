import { execSync } from 'child_process';

export function getBuildInfo() {
  const safe = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return 'unknown';
    }
  };
  return {
    commit: process.env.COMMIT_SHA || safe('git rev-parse --short HEAD'),
    branch: process.env.GIT_BRANCH || safe('git rev-parse --abbrev-ref HEAD'),
    version: process.env.APP_VERSION || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''),
    node: process.version,
  };
}
