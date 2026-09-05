export type JsonObject = Record<string, unknown>;
export type RpcId = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse<T = unknown> {
  id?: RpcId;
  result?: T;
  error?: RpcError;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface InitializeResult {
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
  userAgent?: string;
}

export interface ThreadStatus {
  type?: string;
  [key: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  name?: string | null;
  title?: string | null;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  status?: string | ThreadStatus | null;
  updatedAt?: string | number | null;
  createdAt?: string | number | null;
  source?: string | JsonObject | null;
  [key: string]: unknown;
}

export interface ThreadListResult {
  data: ThreadSummary[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadLoadedListResult {
  data: string[];
  nextCursor?: string | null;
}

export interface LoadedTaskDiagnosticsItem {
  id: string;
  title: string | null;
  name: string | null;
  cwd: string | null;
  status: string | ThreadStatus | null;
  gatewayHeld: boolean;
}

export interface LoadedTasksDiagnosticsResult {
  total: number;
  data: LoadedTaskDiagnosticsItem[];
  unmappedIds: string[];
}

export interface ThreadUnsubscribeResult {
  status: "notLoaded" | "notSubscribed" | "unsubscribed";
}

export interface ThreadSessionSettings {
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
}

export interface ThreadMetadataResult extends ThreadSessionSettings {
  id: string;
}

export interface ThreadReadResult extends ThreadSessionSettings {
  thread: ThreadSummary & {
    turns?: unknown[];
  };
}

export interface ThreadResumeResult extends ThreadReadResult {
  serviceTier?: string | null;
}

export interface ThreadTurnsListResult {
  data: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadPageResult {
  thread: ThreadSummary & {
    turns: unknown[];
  };
  history: {
    kind: "head" | "older";
    olderCursor: string | null;
    hasOlder: boolean;
    loadedOlder?: boolean;
  };
}

export interface TurnResult {
  turn: {
    id: string;
    status?: string;
    [key: string]: unknown;
  };
}

export interface TurnSteerResult {
  turnId: string;
}

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" | "original" | null };

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface ModelSummary {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  serviceTiers?: ModelServiceTier[];
  defaultServiceTier?: string | null;
  inputModalities?: string[];
  supportsPersonality?: boolean;
}

export interface ModelListResult {
  data: ModelSummary[];
  nextCursor?: string | null;
}

export type ReasoningOverrides = Record<string, string>;

export interface ApprovalRequest {
  id: RpcId;
  method: string;
  params: JsonObject;
}

export interface DesktopThreadSnapshot {
  id: string;
  title?: string | null;
  name?: string | null;
  cwd?: string | null;
  status?: string | null;
  projectId?: string | null;
  updatedAt?: string | number | null;
  [key: string]: unknown;
}

export interface ThreadComparison {
  pass: boolean;
  missing: string[];
  extra: string[];
  mismatches: Array<{
    id: string;
    field: string;
    desktop: unknown;
    appServer: unknown;
  }>;
}

export function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function threadStatus(value: unknown): string | null {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  if (!object) return null;
  if (typeof object.type === "string") return object.type;
  if (typeof object.status === "string") return object.status;
  return null;
}

export function threadLabel(thread: ThreadSummary | DesktopThreadSnapshot): string | null {
  const value = thread.name ?? thread.title;
  return typeof value === "string" ? value : null;
}
