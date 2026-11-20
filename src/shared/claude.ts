export interface ClaudeSessionSummary {
  id: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  pending?: boolean;
  status: "unknown" | "running" | "retrying" | "approval" | "completed" | "stopped" | "failed" | "external";
}

export interface ClaudeSessionList {
  data: ClaudeSessionSummary[];
  nextCursor: string | null;
  readOnly: true;
}

export interface ClaudeHistoryPage {
  session: ClaudeSessionSummary;
  messages: Array<{ id: string; items: unknown[] }>;
  olderCursor: string | null;
  readOnly: true;
  settings?: ClaudeRunOptions;
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface ClaudeRunOptions {
  model?: string | undefined;
  effort?: ClaudeEffort | undefined;
  permissionMode?: "default" | "bypassPermissions" | undefined;
}
export interface ClaudeModel {
  value: string;
  displayName: string;
  supportedEffortLevels?: ClaudeEffort[] | undefined;
}
export interface ClaudeSettings {
  effective: ClaudeRunOptions;
  models: ClaudeModel[];
}
export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface ClaudeTask {
  id: string;
  toolUseId?: string;
  parentId?: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  finishedAt: number | null;
  totalTokens?: number;
  toolUses?: number;
  lastTool?: string;
  summary?: string;
  messages: ClaudeHistoryPage["messages"];
}

export interface ClaudeApproval {
  id: string;
  tool: string;
  input: unknown;
}

export interface ClaudeRunSnapshot {
  sessionId: string;
  requestId: string;
  revision: number;
  status: "starting" | "running" | "retrying" | "approval" | "stopping" | "completed" | "stopped" | "failed";
  messages: ClaudeHistoryPage["messages"];
  approvals: ClaudeApproval[];
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  settings?: ClaudeRunOptions;
  usage?: ClaudeUsage;
  tasks?: ClaudeTask[];
  models?: ClaudeModel[];
  lastActivityAt?: number;
  retry?: { attempt: number; maxRetries: number; nextRetryAt: number; message: string };
}
