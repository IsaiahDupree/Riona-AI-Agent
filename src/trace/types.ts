export type Link = { title?: string; url: string };

export type Links = {
  docs?: Link[];
  code?: Link[];
  logs?: { live?: string; tail?: string };
  artifacts?: Link[];
  scheduler?: { pm2?: string; windows?: string };
};

export type TraceStep = {
  stepId: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  ms?: number;
  notes?: string;
};

export type TraceRecord = {
  runId: string;
  jobId?: string;
  action: string;
  target?: { username?: string; postId?: string; permalink?: string };
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  env: Record<string, string | number | boolean | undefined>;
  build: { commit: string; branch: string; version: string; node: string };
  session?: { cookieFile?: string; cookieSha256?: string };
  links: Links;
  steps: TraceStep[];
  error?: { message: string; code?: string; stack?: string } | null;
  metrics?: Record<string, number>;
};
