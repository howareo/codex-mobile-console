import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextUsageFromRpc, readRolloutContextUsage } from "../src/server/context-usage.js";
import { ContextUsageIndicator, contextUsageNotification } from "../web/src/context-usage.js";

const threadId = "019f0000-0000-7000-8000-000000000001";
const filename = `rollout-2026-11-20T10-00-00-${threadId}.jsonl`;

function tokenEvent(totalTokens: number, modelContextWindow: number | null): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: totalTokens - 119, total_tokens: totalTokens },
    total_token_usage: { total_tokens: 900_000 }, model_context_window: modelContextWindow
  } } });
}

async function inTemporaryHome(run: (codexHome: string) => Promise<void>) {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-mobile-context-"));
  try { await run(codexHome); }
  finally { await rm(codexHome, { recursive: true, force: true }); }
}

describe("thread context usage", () => {
  it("uses the latest request total and actual capacity across gateway and web", () => {
    const tokenUsage = { last: { inputTokens: 99_000, cachedInputTokens: 98_000, totalTokens: 108_000 }, total: { totalTokens: 901_000 }, modelContextWindow: 258_400 };
    const usage = { usedTokens: 108_000, modelContextWindow: 258_400 };
    expect(contextUsageFromRpc(tokenUsage)).toEqual(usage);
    const indicator = renderToStaticMarkup(createElement(ContextUsageIndicator, { usage }));
    expect(indicator).toContain("已用 42% · 剩余 58%");
    expect(indicator).toContain("108k / 258k tokens");
    expect(renderToStaticMarkup(createElement(ContextUsageIndicator, { usage: { ...usage, modelContextWindow: null } }))).toContain("108k / 未知");
    expect(contextUsageNotification({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage } })).toEqual({ threadId, usage });
    expect(contextUsageFromRpc({ ...tokenUsage, modelContextWindow: null })).toEqual({ ...usage, modelContextWindow: null });
    expect(contextUsageFromRpc({ ...tokenUsage, last: { totalTokens: -1 } })).toBeNull();
  });

  it("reads the last complete usage from a concurrent session rollout", () => inTemporaryHome(async codexHome => {
    const directory = join(codexHome, "sessions", "2026", "11", "20");
    await mkdir(directory, { recursive: true });
    const path = join(directory, filename);
    const writer = await open(path, "w");
    try {
      await writer.writeFile(`${tokenEvent(90_000, 258_400)}\r\n${tokenEvent(108_000, null)}\n${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } })}\n{"type":"event_msg","payload":{"type":"token_count"`);
      expect(await readRolloutContextUsage(codexHome, path, threadId)).toEqual({ usedTokens: 108_000, modelContextWindow: null });
      expect(await readRolloutContextUsage(codexHome, path, "different-thread")).toBeNull();
    } finally {
      await writer.close();
    }
  }));

  it("bounds the read and only accepts session or archived rollout paths", () => inTemporaryHome(async codexHome => {
    const archive = join(codexHome, "archived_sessions");
    await mkdir(archive);
    const path = join(archive, filename);
    await writeFile(path, `${tokenEvent(1000, 50_000)}\n${"x".repeat(1024 * 1024)}\n`);
    expect(await readRolloutContextUsage(codexHome, path, threadId)).toBeNull();
    await writeFile(path, `${tokenEvent(2000, 50_000)}\n`);
    expect(await readRolloutContextUsage(codexHome, path, threadId)).toEqual({ usedTokens: 2000, modelContextWindow: 50_000 });
    const misplaced = join(codexHome, filename);
    await writeFile(misplaced, tokenEvent(2000, 50_000));
    expect(await readRolloutContextUsage(codexHome, misplaced, threadId)).toBeNull();
  }));
});
