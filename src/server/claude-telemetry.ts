import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRunSnapshot, ClaudeTask, ClaudeUsage } from "../shared/claude.js";
import { safeText } from "./claude-history.js";

const emptyUsage = (): ClaudeUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export class ClaudeTelemetry {
  private readonly usage = new Map<string, { parent: string | null; tokens: ClaudeUsage }>();
  private mainResult: ClaudeUsage | undefined;

  task(snapshot: ClaudeRunSnapshot, toolUseId: string): ClaudeTask {
    snapshot.tasks ??= [];
    let task = snapshot.tasks.find(item => item.toolUseId === toolUseId || item.id === toolUseId);
    if (!task) {
      const ended = snapshot.tasks.findIndex(item => item.status !== "running");
      if (snapshot.tasks.length >= 32 && ended >= 0) snapshot.tasks.splice(ended, 1);
      task = { id: toolUseId, toolUseId, description: "子任务", status: "running", startedAt: Date.now(), finishedAt: null, messages: [] };
      snapshot.tasks.push(task);
    }
    return task;
  }

  private record(id: string, parent: string | null, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, unknown>;
    if (!["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some(key => typeof usage[key] === "number")) return;
    const previous = this.usage.get(id)?.tokens || emptyUsage();
    const tokens = { inputTokens: Math.max(previous.inputTokens, count(usage.input_tokens)), outputTokens: Math.max(previous.outputTokens, count(usage.output_tokens)),
      cacheReadTokens: Math.max(previous.cacheReadTokens, count(usage.cache_read_input_tokens)), cacheWriteTokens: Math.max(previous.cacheWriteTokens, count(usage.cache_creation_input_tokens)) };
    this.usage.set(id, { parent, tokens });
  }

  receive(snapshot: ClaudeRunSnapshot, message: SDKMessage, streams: Map<string, string>): void {
    if (message.type === "assistant") this.record(message.message.id, message.parent_tool_use_id, message.message.usage);
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") this.record(event.message.id, message.parent_tool_use_id, event.message.usage);
      else if (event.type === "message_delta") {
        const id = streams.get(message.parent_tool_use_id || "main");
        if (id) this.record(id, message.parent_tool_use_id, event.usage);
      }
    }
    if (message.type === "result" && message.usage) {
      const usage = message.usage;
      const reported = { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
        cacheReadTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens) };
      if (!message.is_error || Object.values(reported).some(value => value > 0) || this.usage.size === 0) this.mainResult = reported;
    }
    if (this.usage.size || this.mainResult) {
      const total = this.mainResult ? { ...this.mainResult } : emptyUsage();
      for (const { parent, tokens } of this.usage.values()) {
        // Result usage is main-loop only; modelUsage is session-cumulative after resume.
        if (this.mainResult && !parent) continue;
        for (const key of Object.keys(total) as (keyof ClaudeUsage)[]) total[key] += tokens[key];
      }
      snapshot.usage = total;
    }
    if (message.type === "system" && ["task_started", "task_progress", "task_notification", "task_updated"].includes(message.subtype)) {
      const event = message as Extract<SDKMessage, { subtype: "task_started" | "task_progress" | "task_notification" | "task_updated" }>;
      if (("ambient" in event && event.ambient) || ("skip_transcript" in event && event.skip_transcript)) return;
      const task = this.task(snapshot, "tool_use_id" in event && event.tool_use_id ? event.tool_use_id : event.task_id);
      task.id = event.task_id;
      if ("description" in event) task.description = safeText(event.description, 200);
      if ("parent_task_id" in event) task.parentId = event.parent_task_id;
      if ("usage" in event && event.usage) {
        task.totalTokens = count(event.usage.total_tokens);
        task.toolUses = count(event.usage.tool_uses);
        task.startedAt = Date.now() - count(event.usage.duration_ms);
      }
      if ("last_tool_name" in event && event.last_tool_name) task.lastTool = safeText(event.last_tool_name, 100);
      if ("summary" in event) task.summary = safeText(event.summary, 2000);
      if (event.subtype === "task_notification") { task.status = event.status; task.finishedAt = Date.now(); }
      if (event.subtype === "task_updated") {
        if (event.patch.description) task.description = safeText(event.patch.description, 200);
        if (event.patch.error) task.summary = safeText(event.patch.error, 2000);
        if (["completed", "failed", "killed"].includes(event.patch.status || "")) {
          task.status = event.patch.status === "killed" ? "stopped" : event.patch.status as "completed" | "failed";
          task.finishedAt = Date.now();
        }
      }
    }
    if (message.type === "tool_progress" && message.parent_tool_use_id) {
      this.task(snapshot, message.parent_tool_use_id).lastTool = safeText(message.tool_name, 100);
    }
  }
}
