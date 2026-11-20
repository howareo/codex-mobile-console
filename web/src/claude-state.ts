import type { ClaudeRunSnapshot, ClaudeUsage } from "../../src/shared/claude";
import { statusClass } from "./thread-items";

export function claudeStatusClass(status: string): ReturnType<typeof statusClass> {
  if (["starting", "stopping", "approval"].includes(status)) return "running";
  return statusClass(status === "stopped" ? "interrupted" : status);
}

export function claudeElapsed(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ""}${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function claudeTokenTotal(usage: ClaudeUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function mergeClaudeRun(current: Record<string, ClaudeRunSnapshot>, next: ClaudeRunSnapshot): Record<string, ClaudeRunSnapshot> {
  const previous = current[next.sessionId];
  if (previous && (previous.startedAt > next.startedAt || previous.requestId === next.requestId && previous.revision > next.revision)) return current;
  return { ...current, [next.sessionId]: next };
}
