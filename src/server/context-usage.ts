import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { ThreadContextUsage } from "../shared/types.js";

const MAX_ROLLOUT_TAIL_BYTES = 1024 * 1024;

export function contextUsageFromRpc(tokenUsage: unknown): ThreadContextUsage | null {
  const usage = record(tokenUsage);
  return contextUsage(record(usage?.last)?.totalTokens, usage?.modelContextWindow);
}

export async function readRolloutContextUsage(codexHome: unknown, path: unknown, threadId: string): Promise<ThreadContextUsage | null> {
  if (typeof codexHome !== "string" || !isAbsolute(codexHome) || typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    const [home, rollout] = await Promise.all([realpath(codexHome), realpath(path)]);
    const tree = relative(home, rollout).split(sep, 1)[0];
    const filename = basename(rollout);
    if (tree !== "sessions" && tree !== "archived_sessions") return null;
    if (!filename.startsWith("rollout-") || !filename.endsWith(`-${threadId}.jsonl`)) return null;

    // Node/libuv's read-only open shares reads, writes, and deletes on Windows.
    const file = await open(rollout, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return null;
      // shortcut: read only the last MiB, expand the bounded tail if real rollouts often exceed it between token events.
      const position = Math.max(0, stat.size - MAX_ROLLOUT_TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - position);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      for (let i = lines.length - 1; i >= (position === 0 ? 0 : 1); i--) {
        const line = lines[i];
        if (!line?.includes('"token_count"')) continue;
        try {
          const event = record(JSON.parse(line));
          const payload = record(event?.payload);
          if (event?.type !== "event_msg" || payload?.type !== "token_count") continue;
          const info = record(payload.info);
          const usage = contextUsage(record(info?.last_token_usage)?.total_tokens, info?.model_context_window);
          if (usage) return usage;
        } catch {
          // The writer may have left the final line incomplete.
        }
      }
      return null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

function contextUsage(lastTotalTokens: unknown, contextWindow: unknown): ThreadContextUsage | null {
  if (typeof lastTotalTokens !== "number" || !Number.isSafeInteger(lastTotalTokens) || lastTotalTokens < 0) return null;
  const modelContextWindow = typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : null;
  return { usedTokens: lastTotalTokens, modelContextWindow };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
