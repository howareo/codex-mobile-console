import type { ReasoningOverrides, ThreadMetadataResult, ThreadSummary } from "../../src/shared/types";

const CACHE_VERSION = 3;
const CACHE_PREFIX = "codex-mobile:";
const MAX_CACHE_BYTES = 128 * 1024;
const MAX_DRAFT_BYTES = 32 * 1024;
const MAX_DRAFT_BYTES_PER_THREAD = 8 * 1024;
const MAX_MODEL_OVERRIDES = 100;

export interface AuthSessionInfo {
  ok: true;
  epoch: string;
  expiresAt: number;
}

export interface ClientCache {
  version: 3;
  expiresAt: number;
  threads: ThreadSummary[];
  drafts: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningOverrides: ReasoningOverrides;
  lastThreadId: string | null;
}

export interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

export function shouldReportAuthExpired(requestGeneration: number, currentGeneration: number, status: number, path: string): boolean {
  return status === 401 && requestGeneration === currentGeneration && path !== "/api/auth/session";
}

export function cacheNamespace(origin: string, build: string, epoch: string): string {
  return `${CACHE_PREFIX}${origin}:${build}:${epoch}`;
}

export function pickThreadFields(thread: ThreadSummary): ThreadSummary {
  const picked: ThreadSummary = { id: thread.id };
  if (thread.name !== undefined) picked.name = thread.name;
  if (thread.title !== undefined) picked.title = thread.title;
  if (thread.cwd !== undefined) picked.cwd = thread.cwd;
  if (thread.model !== undefined) picked.model = thread.model;
  if (thread.modelProvider !== undefined) picked.modelProvider = thread.modelProvider;
  if (thread.reasoningEffort !== undefined) picked.reasoningEffort = thread.reasoningEffort;
  if (thread.status !== undefined) picked.status = thread.status;
  if (thread.updatedAt !== undefined) picked.updatedAt = thread.updatedAt;
  if (thread.createdAt !== undefined) picked.createdAt = thread.createdAt;
  return picked;
}

export function clearThreadOverride<T extends string>(overrides: Record<string, T>, threadId: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(overrides, threadId)) return overrides;
  const next = { ...overrides };
  delete next[threadId];
  return next;
}

export function readClientCache(storage: StorageLike, origin: string, build: string, epoch: string, now = Date.now()): ClientCache | null {
  try {
    const raw = storage.getItem(cacheNamespace(origin, build, epoch));
    if (!raw || raw.length > MAX_CACHE_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<ClientCache>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) return null;
    if (!Array.isArray(parsed.threads) || !validCachedThreads(parsed.threads) || !validDrafts(parsed.drafts)) return null;
    return {
      version: CACHE_VERSION,
      expiresAt: parsed.expiresAt,
      threads: parsed.threads.map(pickThreadFields),
      drafts: sanitizeDrafts(parsed.drafts),
      modelOverrides: sanitizeModelOverrides(parsed.modelOverrides),
      reasoningOverrides: sanitizeModelOverrides(parsed.reasoningOverrides),
      lastThreadId: typeof parsed.lastThreadId === "string" ? parsed.lastThreadId : null
    };
  } catch {
    return null;
  }
}

export function writeClientCache(storage: StorageLike, origin: string, build: string, session: AuthSessionInfo, threads: ThreadSummary[], drafts: Record<string, string>, modelOverrides: Record<string, string>, reasoningOverrides: ReasoningOverrides, lastThreadId: string | null): void {
  const key = cacheNamespace(origin, build, session.epoch);
  const record: ClientCache = {
    version: CACHE_VERSION,
    expiresAt: session.expiresAt,
    threads: threads.filter(thread => typeof thread.id === "string" && thread.id.length > 0).map(pickThreadFields),
    drafts: sanitizeDrafts(drafts),
    modelOverrides: sanitizeModelOverrides(modelOverrides),
    reasoningOverrides: sanitizeModelOverrides(reasoningOverrides),
    lastThreadId
  };
  try {
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_CACHE_BYTES) return;
    removeOtherClientCaches(storage, key);
    storage.setItem(key, serialized);
  } catch {
    // iOS may evict or temporarily deny PWA storage; cache is always best-effort.
  }
}

export function clearClientCaches(storage: StorageLike): void {
  removeOtherClientCaches(storage, null);
}

export function resumeDecision(input: { lastFrameAgeMs: number; readyState: number | null; visibility: DocumentVisibilityState }): "idle" | "resync" | "reconnect" {
  if (input.visibility === "hidden") return "idle";
  return input.readyState === WebSocket.OPEN && input.lastFrameAgeMs <= 30_000 ? "resync" : "reconnect";
}

export function pollIntervalMs(input: { visibility: DocumentVisibilityState; realtimeState: string }): number | null {
  if (input.visibility === "hidden") return null;
  return input.realtimeState === "open" ? null : 10_000;
}

export function realtimeThreadId(view: string, selectedId: string | null): string | null {
  return view === "threads" ? selectedId : null;
}

export function mergeThreadSummary<T extends ThreadSummary>(thread: T, summary?: ThreadSummary): T & ThreadSummary {
  if (!summary || summary.id !== thread.id) return thread;
  return {
    ...summary,
    ...thread,
    ...(summary.model !== undefined ? { model: summary.model } : {}),
    ...(summary.modelProvider !== undefined ? { modelProvider: summary.modelProvider } : {}),
    ...(summary.reasoningEffort !== undefined ? { reasoningEffort: summary.reasoningEffort } : {})
  };
}

export function mergeThreadMetadata<T extends ThreadSummary>(thread: T, metadata?: ThreadMetadataResult): T & ThreadSummary {
  if (!metadata || metadata.id !== thread.id) return thread;
  return {
    ...thread,
    ...(metadata.model !== undefined ? { model: metadata.model } : {}),
    ...(metadata.modelProvider !== undefined ? { modelProvider: metadata.modelProvider } : {}),
    ...(metadata.reasoningEffort !== undefined ? { reasoningEffort: metadata.reasoningEffort } : {})
  };
}

function removeOtherClientCaches(storage: StorageLike, keep: string | null): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(CACHE_PREFIX) && key !== keep) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

function validCachedThreads(value: unknown[]): value is ThreadSummary[] {
  return value.every(thread => typeof thread === "object" && thread !== null && typeof (thread as { id?: unknown }).id === "string");
}

function validDrafts(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, draft]) => key.length > 0 && typeof draft === "string");
}

function sanitizeDrafts(drafts: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  let total = 0;
  for (const [threadId, draft] of Object.entries(drafts)) {
    if (!draft || draft.length > MAX_DRAFT_BYTES_PER_THREAD || total + draft.length > MAX_DRAFT_BYTES) continue;
    result[threadId] = draft;
    total += draft.length;
  }
  return result;
}

function sanitizeModelOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [threadId, model] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_MODEL_OVERRIDES || !threadId || typeof model !== "string") continue;
    if (typeof model === "string" && (!model.trim() || model.length > 200)) continue;
    result[threadId] = model;
  }
  return result;
}
