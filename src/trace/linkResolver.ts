const DOCS = process.env.DOCS_BASE_URL || '/docs';
const REPO = process.env.REPO_URL || '';
const MAIN = process.env.REPO_MAIN_BRANCH || 'main';
const ART = process.env.ARTIFACT_BASE_URL || '/api/trace/artifacts';
const PM2 = process.env.PM2_DASHBOARD_URL || '';
const LOG_UI = process.env.LOG_UI_BASE_URL || '';

export const doc = (slug: string) => `${DOCS}/${slug}`;
export const techDoc = (name: string) => doc(`technical-docs/${name}`);
export const howItWorks = () => doc('HOW-IT-WORKS.md');
export const srcAt = (path: string, commit?: string, line?: number) =>
  REPO ? `${REPO}/blob/${commit || MAIN}/${path}${line ? `#L${line}` : ''}` : `/${path}`;
export const artifact = (runId: string, name: string) => `${ART}/${runId}/${encodeURIComponent(name)}`;
export const pm2App = (app = 'instagram-scheduler') => (PM2 ? `${PM2}/app/${encodeURIComponent(app)}` : '');
export const logsLive = (app = 'instagram-scheduler') => (LOG_UI ? `${LOG_UI}/apps/${encodeURIComponent(app)}` : '');
export const logsTailApi = (runId: string) => `/api/trace/logs/tail?runId=${encodeURIComponent(runId)}`;
