import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRunSnapshot } from "../src/shared/claude.js";
import { ClaudeTelemetry } from "../src/server/claude-telemetry.js";
import { claudeElapsed, claudeTokenTotal } from "../web/src/claude-state.js";
import { ClaudeRunProgress, ClaudeTasks } from "../web/src/claude-controls.js";

const frame = (value: unknown) => value as SDKMessage;
function snapshot(): ClaudeRunSnapshot { return { sessionId: "session", requestId: "request", revision: 0, status: "running", messages: [], approvals: [], error: null, startedAt: 1000, finishedAt: null, tasks: [] }; }

describe("Claude live telemetry", () => {
  it("updates reported streaming tokens without double counting repeated blocks or cumulative resumed totals", () => {
    const run = snapshot(); const tracker = new ClaudeTelemetry(); const streams = new Map([["main", "main-api"], ["agent-tool", "child-api"]]);
    const receive = (message: unknown) => tracker.receive(run, frame(message), streams);
    receive({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "main-api", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } } });
    expect(claudeTokenTotal(run.usage!)).toBe(131);
    receive({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 9 } } });
    expect(run.usage!.outputTokens).toBe(9);
    const completed = { type: "assistant", parent_tool_use_id: null, message: { id: "main-api", usage: { input_tokens: 100, output_tokens: 9 } } };
    receive(completed); receive(completed);
    expect(claudeTokenTotal(run.usage!)).toBe(139);
    receive({ type: "assistant", parent_tool_use_id: "agent-tool", message: { id: "child-api", usage: { input_tokens: 50, output_tokens: 5 } } });
    expect(claudeTokenTotal(run.usage!)).toBe(194);
    receive({ type: "result", is_error: true, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(claudeTokenTotal(run.usage!)).toBe(194);
    receive({ type: "result", is_error: false, usage: { input_tokens: 105, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }, modelUsage: { opus: { inputTokens: 999999, outputTokens: 999999 } } });
    expect(claudeTokenTotal(run.usage!)).toBe(200);
  });

  it("correlates child output before task_started, updates progress, preserves failures and hides housekeeping", () => {
    const run = snapshot(); const tracker = new ClaudeTelemetry();
    const task = tracker.task(run, "tool-1"); task.messages.push({ id: "child-message", items: [{ type: "agentMessage", text: "child output" }] });
    tracker.receive(run, frame({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-1", description: "执行测试", parent_task_id: "parent" }), new Map());
    tracker.receive(run, frame({ type: "system", subtype: "task_progress", task_id: "task-1", tool_use_id: "tool-1", description: "执行测试", last_tool_name: "Bash", usage: { total_tokens: 88, tool_uses: 2, duration_ms: 3000 } }), new Map());
    expect(run.tasks).toHaveLength(1);
    expect(run.tasks![0]).toMatchObject({ id: "task-1", parentId: "parent", totalTokens: 88, toolUses: 2, lastTool: "Bash", messages: [{ id: "child-message" }] });
    tracker.receive(run, frame({ type: "system", subtype: "task_notification", task_id: "task-1", status: "failed", summary: "502 Bad Gateway" }), new Map());
    expect(run.tasks![0]).toMatchObject({ status: "failed", summary: "502 Bad Gateway" });
    tracker.receive(run, frame({ type: "system", subtype: "task_started", task_id: "watcher", ambient: true, description: "watch" }), new Map());
    expect(run.tasks).toHaveLength(1);
    expect(run.messages).toEqual([]);
    const html = renderToStaticMarkup(createElement(ClaudeTasks, { run }));
    expect(html).toContain("502 Bad Gateway"); expect(html).toContain("child output");
  });

  it("renders exact elapsed time, reported usage and a compact expandable status", () => {
    expect(claudeElapsed(1000, 139000)).toBe("02:18");
    expect(claudeElapsed(1000, 3662000)).toBe("1:01:01");
    expect(claudeElapsed(1000, 0)).toBe("00:00");
    const run = snapshot(); run.finishedAt = 139000; run.status = "completed";
    run.usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 };
    const html = renderToStaticMarkup(createElement(ClaudeRunProgress, { run }));
    expect(html).toContain("02:18"); expect(html).toContain("Token 150"); expect(html).toContain("<summary>");
    expect(html).toContain("缓存读取 30"); expect(html).toContain("尚未上报");
  });
});
