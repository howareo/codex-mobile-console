import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeModel, ClaudeRunOptions, ClaudeRunSnapshot, ClaudeSessionSummary, ClaudeSettings } from "../shared/claude.js";
import { ClaudeReadError, projectClaudeMessage, safeInput, safeText } from "./claude-history.js";
import { ClaudeTelemetry } from "./claude-telemetry.js";
import { localClaudeSettings } from "./claude-settings.js";
import { claudeCliPath } from "./claude-versions.js";

type Runner = Pick<Query, typeof Symbol.asyncIterator | "close"> & Partial<Pick<Query, "supportedModels">>;
export type ClaudeRunner = (id: string, cwd: string, text: string, controller: AbortController, canUseTool: CanUseTool, requestId: string, settings: ClaudeRunOptions, newSession?: boolean) => Runner;
type Pending = { resolve: (allow: boolean, answers?: Record<string, string>) => void; questions: string[] };
type Run = { snapshot: ClaudeRunSnapshot; controller: AbortController; runner?: Runner; pending: Map<string, Pending>; streams: Map<string, string>; telemetry: ClaudeTelemetry; timer?: ReturnType<typeof setTimeout> };
const active = (run: Run) => run.snapshot.finishedAt === null;

export async function externalClaudeSessions(): Promise<Set<string>> {
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new ClaudeReadError(503, "暂时无法核对本机 Claude 会话占用，请稍后再试");
  }
  const sessions = new Set<string>();
  for (const name of files.filter(name => /^\d+\.json$/.test(name))) {
    try {
      const marker = JSON.parse(await readFile(join(directory, name), "utf8")) as { pid?: number; sessionId?: string };
      if (!Number.isSafeInteger(marker.pid) || marker.pid! < 1 || typeof marker.sessionId !== "string") continue;
      process.kill(marker.pid!, 0);
      sessions.add(marker.sessionId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      // A live CLI may be replacing its marker; defer sending rather than risk two writers.
      throw new ClaudeReadError(503, "Claude 会话占用信息正在更新，请稍后重试");
    }
  }
  return sessions;
}

const startCli: ClaudeRunner = (id, cwd, text, controller, canUseTool, requestId, settings, newSession) => {
  const executable = claudeCliPath();
  if (!existsSync(executable)) throw new ClaudeReadError(503, "未找到本机 Claude CLI，请先完成 Claude Code 安装和登录");
  const prompt = { async *[Symbol.asyncIterator]() {
    yield { type: "user" as const, uuid: requestId as ReturnType<typeof randomUUID>, session_id: id, parent_tool_use_id: null,
      origin: { kind: "human" as const }, message: { role: "user" as const, content: text } };
  } };
  return query({ prompt, options: {
    ...(newSession ? { sessionId: id } : { resume: id }), cwd, pathToClaudeCodeExecutable: executable, abortController: controller,
    settingSources: ["user", "project", "local"], systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true, forwardSubagentText: true, allowDangerouslySkipPermissions: true, canUseTool,
    ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
    env: { ...process.env, CLAUDECODE: undefined, CLAUDE_AGENT_SDK_CLIENT_APP: "codex-mobile-console" }
  } });
};

export class ClaudeRuns {
  private readonly runs = new Map<string, Run>();
  private readonly requests = new Map<string, { signature: string; run: Run }>();
  private readonly listeners = new Set<(run: ClaudeRunSnapshot) => void>();
  private readonly starting = new Set<string>();
  private models: ClaudeModel[] = [];

  constructor(private readonly find: (id: string) => Promise<ClaudeSessionSummary>, private readonly invalidate: (id: string) => void,
    private readonly runner: ClaudeRunner = startCli, private readonly external = externalClaudeSessions,
    private readonly settingsSource: (id: string, cwd: string) => Promise<ClaudeSettings> = (_id, cwd) => localClaudeSettings(cwd)) {}

  snapshots(): ClaudeRunSnapshot[] { return [...this.runs.values()].map(run => run.snapshot); }

  subscribe(listener: (run: ClaudeRunSnapshot) => void): () => void {
    if (this.listeners.size >= 16) throw new ClaudeReadError(429, "Claude 实时连接过多，请关闭多余页面");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async statuses(): Promise<Map<string, ClaudeSessionSummary["status"]>> {
    const result = new Map<string, ClaudeSessionSummary["status"]>([...await this.external()].map(id => [id, "external"]));
    for (const [id, run] of this.runs) {
      if (!active(run) && result.has(id)) continue;
      const status = run.snapshot.status;
      result.set(id, status === "starting" || status === "stopping" ? "running" : status);
    }
    return result;
  }

  async settings(id: string): Promise<ClaudeSettings> {
    const session = await this.find(id);
    const settings = await this.settingsSource(id, session.cwd || homedir());
    return { effective: this.runs.get(id)?.snapshot.settings || settings.effective,
      models: [...new Map([...settings.models, ...this.models].map(model => [model.value, model])).values()] };
  }

  async send(id: string, text: string, requestId: string, options: ClaudeRunOptions = {}): Promise<ClaudeRunSnapshot> {
    const signature = createHash("sha256").update(JSON.stringify([id, text, options])).digest("hex");
    const duplicate = this.requests.get(requestId);
    if (duplicate) {
      if (duplicate.signature !== signature) throw new ClaudeReadError(409, "该发送编号已用于另一条消息，请刷新后重试");
      return duplicate.run.snapshot;
    }
    if (this.starting.has(id) || (this.runs.has(id) && active(this.runs.get(id)!))) throw new ClaudeReadError(409, "此会话正在运行，请等待结束或先停止");
    if (this.starting.size + [...this.runs.values()].filter(active).length >= 4) throw new ClaudeReadError(429, "已有四个 Claude 会话运行，请稍后再发");
    this.starting.add(id);
    try {
      const session = await this.find(id);
      if (!session.cwd) throw new ClaudeReadError(409, "此会话缺少工作目录，暂时无法继续");
      if ((await this.external()).has(id)) throw new ClaudeReadError(409, "此会话仍由电脑端 Claude 占用，请先退出对应终端，再从手机继续");
      const settings = { ...(await this.settings(id)).effective, ...options };
      const run: Run = { snapshot: { sessionId: id, requestId, revision: 0, status: "starting", messages: [
        { id: requestId, items: [{ id: `${requestId}:0`, type: "userMessage", text: safeText(text) }] }
      ], approvals: [], error: null, startedAt: Date.now(), lastActivityAt: Date.now(), finishedAt: null, settings, tasks: [] }, controller: new AbortController(), pending: new Map(), streams: new Map(), telemetry: new ClaudeTelemetry() };
      for (const [key, previous] of this.runs) if (this.runs.size >= 32 && !active(previous)) { this.runs.delete(key); break; }
      for (const [key, previous] of this.requests) if (this.requests.size >= 128 && !active(previous.run)) { this.requests.delete(key); break; }
      this.runs.set(id, run);
      this.requests.set(requestId, { signature, run });
      this.publish(run);
      void this.consume(run, session.cwd, text, session.pending);
      return run.snapshot;
    } finally { this.starting.delete(id); }
  }

  stop(id: string, requestId: string): ClaudeRunSnapshot {
    const run = this.current(id, requestId);
    if (!active(run)) return run.snapshot;
    run.snapshot.status = "stopping";
    this.publish(run);
    run.controller.abort();
    for (const pending of run.pending.values()) pending.resolve(false);
    run.runner?.close();
    return run.snapshot;
  }

  decide(id: string, requestId: string, approvalId: string, allow: boolean, answers?: Record<string, string>): ClaudeRunSnapshot {
    const run = this.current(id, requestId);
    const pending = run.pending.get(approvalId);
    if (!pending || !active(run)) throw new ClaudeReadError(409, "该审批已结束，请刷新会话");
    if (allow && pending.questions.length && (!answers || pending.questions.some(question => !answers[question]?.trim()))) {
      throw new ClaudeReadError(400, "请回答所有问题后再提交");
    }
    if (answers && Object.keys(answers).some(key => !pending.questions.includes(key))) throw new ClaudeReadError(400, "问题已变化，请刷新后重试");
    pending.resolve(allow, answers);
    return run.snapshot;
  }

  close(): void { for (const [id, run] of this.runs) if (active(run)) this.stop(id, run.snapshot.requestId); }

  private current(id: string, requestId: string): Run {
    const run = this.runs.get(id);
    if (!run || run.snapshot.requestId !== requestId) throw new ClaudeReadError(409, "运行记录已变化，请刷新会话后重试");
    return run;
  }

  private publish(run: Run, immediate = true): void {
    run.snapshot.revision++;
    const emit = () => { delete run.timer; for (const listener of this.listeners) listener(run.snapshot); };
    if (immediate) { if (run.timer) clearTimeout(run.timer); emit(); }
    else if (!run.timer) run.timer = setTimeout(emit, 200);
  }

  private async consume(run: Run, cwd: string, text: string, newSession?: boolean): Promise<void> {
    const id = run.snapshot.sessionId;
    const canUseTool: CanUseTool = (tool, input, options) => new Promise(resolve => {
      if (options.signal.aborted || run.controller.signal.aborted || run.pending.size >= 16) { resolve({ behavior: "deny", message: "任务已停止或待审批操作过多" }); return; }
      const approvalId = randomUUID();
      const questions = tool === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions
        .map(value => value !== null && typeof value === "object" && "question" in value && typeof value.question === "string" ? value.question : "").filter(Boolean) : [];
      const finish = (allow: boolean, answers?: Record<string, string>) => {
        if (!run.pending.delete(approvalId)) return;
        options.signal.removeEventListener("abort", abort);
        run.snapshot.approvals = run.snapshot.approvals.filter(item => item.id !== approvalId);
        if (active(run) && !run.controller.signal.aborted) run.snapshot.status = run.pending.size ? "approval" : "running";
        resolve(allow ? { behavior: "allow", updatedInput: questions.length ? { ...input, answers } : input } : { behavior: "deny", message: "用户拒绝或停止了该操作" });
        this.publish(run);
      };
      const abort = () => finish(false);
      run.pending.set(approvalId, { resolve: finish, questions });
      options.signal.addEventListener("abort", abort, { once: true });
      run.snapshot.approvals.push({ id: approvalId, tool: safeText(tool, 160), input: safeInput(input) });
      run.snapshot.status = "approval";
      this.publish(run);
    });
    try {
      run.runner = this.runner(id, cwd, text, run.controller, canUseTool, run.snapshot.requestId, run.snapshot.settings || {}, newSession);
      void run.runner.supportedModels?.().then(models => {
        if (!active(run) || run.controller.signal.aborted) return;
        this.models = models.slice(0, 100).map(model => ({ value: safeText(model.value, 200), displayName: safeText(model.displayName, 200),
          supportedEffortLevels: model.supportedEffortLevels || (model.supportsEffort === false ? [] : undefined) }));
        run.snapshot.models = this.models;
        this.publish(run);
      }).catch(() => { /* Configured aliases remain usable when discovery is unavailable. */ });
      for await (const message of run.runner) {
        if (run.controller.signal.aborted) break;
        this.receive(run, message);
      }
      if (!run.controller.signal.aborted && run.snapshot.status !== "failed" && run.snapshot.status !== "completed") {
        throw new Error("Claude 连接已结束，但未收到任务完成结果；请检查会话后再决定是否重试");
      }
    } catch (error) {
      if (!run.controller.signal.aborted) {
        run.snapshot.status = "failed";
        run.snapshot.error = safeText(error instanceof Error ? error.message : "Claude 执行失败", 3000);
      }
    } finally {
      run.snapshot.finishedAt = Date.now();
      delete run.snapshot.retry;
      for (const pending of run.pending.values()) pending.resolve(false);
      run.runner?.close();
      if (run.controller.signal.aborted) run.snapshot.status = "stopped";
      run.snapshot.approvals = [];
      for (const task of run.snapshot.tasks || []) if (task.finishedAt === null) {
        task.status = "stopped"; task.finishedAt = run.snapshot.finishedAt;
        task.summary ||= "主任务已结束，未收到此子任务的完成确认";
      }
      this.invalidate(id);
      this.publish(run);
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: "claude.run.finished", sessionId: id, requestId: run.snapshot.requestId, status: run.snapshot.status, error: run.snapshot.error }));
    }
  }

  private receive(run: Run, message: SDKMessage): void {
    const snapshot = run.snapshot;
    if (message.type === "system" && message.subtype === "api_retry") {
      const reason = message.error_status === null ? "连接超时或中断，上游未返回有效响应"
        : `HTTP ${message.error_status} · ${message.error === "rate_limit" ? "请求限流" : message.error === "overloaded" ? "上游繁忙" : "上游请求失败"}`;
      snapshot.retry = { attempt: message.attempt, maxRetries: message.max_retries,
        nextRetryAt: Date.now() + message.retry_delay_ms, message: reason };
      if (!run.pending.size && !run.controller.signal.aborted) snapshot.status = "retrying";
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "claude.run.retry", sessionId: snapshot.sessionId,
        requestId: snapshot.requestId, ...snapshot.retry }));
      this.publish(run);
      return;
    }
    if (["assistant", "stream_event", "tool_progress", "result"].includes(message.type)) {
      snapshot.lastActivityAt = Date.now();
      delete snapshot.retry;
      if (snapshot.status === "retrying") snapshot.status = run.pending.size ? "approval" : "running";
    }
    run.telemetry.receive(snapshot, message, run.streams);
    const parent = "parent_tool_use_id" in message ? message.parent_tool_use_id : null;
    const messages = parent ? run.telemetry.task(snapshot, parent).messages : snapshot.messages;
    if (message.type === "result") {
      snapshot.status = message.is_error ? "failed" : "completed";
      snapshot.error = message.is_error ? safeText("errors" in message ? message.errors.join("\n") : "Claude 返回执行错误", 3000) : null;
    } else if (message.type === "assistant" || message.type === "user") {
      const uuid = message.uuid || randomUUID();
      const projected = projectClaudeMessage({ ...message, uuid, session_id: message.session_id || snapshot.sessionId,
        parent_tool_use_id: message.parent_tool_use_id ?? null, parent_agent_id: null });
      if (message.type === "user" && projected.items.every(item => (item as { type: string }).type === "userMessage")) return;
      for (const value of projected.items) {
        const item = value as Record<string, unknown>;
        if (item.type === "dynamicToolCall" && message.type === "assistant") item.status = "running";
        if (item.type === "dynamicToolCall" && message.type === "user" && item.toolUseId) {
          for (const previous of [snapshot.messages, ...(snapshot.tasks || []).map(task => task.messages)].flat()) for (const entry of previous.items as Record<string, unknown>[]) {
            if (entry.toolUseId === item.toolUseId) entry.status = item.status;
          }
        }
      }
      const index = messages.findIndex(item => item.id === uuid || message.type === "assistant" && item.id === message.message.id);
      if (index >= 0) messages[index] = projected;
      else messages.push(projected);
    } else if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") {
        run.streams.set(message.parent_tool_use_id || "main", event.message.id);
        messages.push({ id: event.message.id, items: [] });
      } else if (event.type === "content_block_start" || event.type === "content_block_delta") {
        const partialId = run.streams.get(message.parent_tool_use_id || "main");
        const current = messages.find(item => item.id === partialId);
        if (!current) return;
        const itemId = `${current.id}:${event.index}`;
        const items = current.items as Record<string, unknown>[];
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") items.push({ id: itemId, type: "agentMessage", text: safeText(block.text) });
          else if (block.type === "thinking") items.push({ id: itemId, type: "reasoning", summary: [safeText(block.thinking)] });
          else if (block.type === "tool_use") items.push({ id: itemId, type: "dynamicToolCall", tool: safeText(block.name, 160), toolUseId: block.id, status: "running", result: "准备执行工具" });
        } else {
          const item = items.find(item => item.id === itemId);
          if (!item) return;
          if (event.delta.type === "text_delta") item.text = safeText(String(item.text || "") + event.delta.text);
          else if (event.delta.type === "thinking_delta") item.summary = [safeText(String((item.summary as string[] | undefined)?.[0] || "") + event.delta.thinking)];
        }
      }
    } else if (message.type === "system" && message.subtype === "init") {
      snapshot.status = "running";
      snapshot.settings ||= {};
      if (message.model) snapshot.settings.model = safeText(message.model, 200);
      if (message.permissionMode === "default" || message.permissionMode === "bypassPermissions") snapshot.settings.permissionMode = message.permissionMode;
      if (message.effort) snapshot.settings.effort = message.effort;
      else if (message.effort === null) delete snapshot.settings.effort;
    }
    for (const task of snapshot.tasks || []) task.messages = task.messages.slice(-12);
    snapshot.messages = snapshot.messages.slice(-30);
    this.publish(run, message.type === "result");
  }
}
