import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import Fastify from "fastify";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuns, type ClaudeRunner } from "../src/server/claude-runs.js";
import { createClaudeBackend } from "../src/server/claude-backend.js";
import { registerClaudeProxy } from "../src/server/claude-proxy.js";
import { ClaudeSessionStore } from "../src/server/claude-store.js";
import type { ClaudeRunSnapshot } from "../src/shared/claude.js";
import { mergeClaudeRun } from "../web/src/claude-state.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const find = async (id: string) => ({ id, title: "测试", cwd: "C:\\project", updatedAt: 1, status: "unknown" as const });
const frame = (value: unknown) => value as SDKMessage;
const result = () => frame({ type: "result", is_error: false, subtype: "success" });
function pendingRunner(): { runner: ClaudeRunner; closed: ReturnType<typeof vi.fn> } {
  const closed = vi.fn();
  const runner: ClaudeRunner = (_id, _cwd, _text, controller) => Object.assign((async function* () {
    yield frame({ type: "system", subtype: "init" });
    await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  })(), { close: closed });
  return { runner: vi.fn(runner), closed };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

vi.mock("../src/server/claude-settings.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/server/claude-settings.js")>(),
  localClaudeSettings: vi.fn(async () => ({ effective: {}, models: [] })) }));

describe("Claude mobile control", () => {
  it("inherits session settings, forwards explicit overrides and reports the CLI's actual settings", async () => {
    const { runner } = pendingRunner();
    const source = vi.fn(async () => ({ effective: { model: "session-model", effort: "high" as const, permissionMode: "bypassPermissions" as const }, models: [] }));
    const runs = new ClaudeRuns(find, vi.fn(), runner, async () => new Set(), source);
    try {
      expect((await runs.settings(sessionId)).effective.model).toBe("session-model"); expect(runner).not.toHaveBeenCalled();
      const requestId = randomUUID();
      await runs.send(sessionId, "same", requestId, { effort: "low" });
      expect(runner).toHaveBeenCalledWith(sessionId, "C:\\project", "same", expect.any(AbortController), expect.any(Function), requestId,
        { model: "session-model", effort: "low", permissionMode: "bypassPermissions" }, undefined);
      await expect(runs.send(sessionId, "same", requestId, { effort: "max" })).rejects.toMatchObject({ statusCode: 409 });
    } finally { runs.close(); }
  });

  it("keeps streamed child responses out of the main transcript", async () => {
    const factory: ClaudeRunner = () => Object.assign((async function* () {
      yield frame({ type: "system", subtype: "init", model: "resolved-model", permissionMode: "bypassPermissions", effort: "medium" });
      yield frame({ type: "stream_event", parent_tool_use_id: "agent-tool", event: { type: "message_start", message: { id: "child-api", usage: { input_tokens: 5, output_tokens: 0 } } } });
      yield frame({ type: "stream_event", parent_tool_use_id: "agent-tool", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "child answer" } } });
      yield frame({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "agent-tool", description: "子任务" });
      yield frame({ type: "system", subtype: "task_notification", task_id: "child", status: "completed", summary: "done" });
      yield result();
    })(), { close: vi.fn() });
    const runs = new ClaudeRuns(find, vi.fn(), factory, async () => new Set());
    try {
      const run = await runs.send(sessionId, "go", randomUUID());
      await vi.waitFor(() => expect(run.finishedAt).not.toBeNull());
      expect(JSON.stringify(run.messages)).not.toContain("child answer");
      expect(JSON.stringify(run.tasks)).toContain("child answer");
      expect(run.settings).toEqual({ model: "resolved-model", effort: "medium", permissionMode: "bypassPermissions" });
      expect(run.tasks?.[0]?.status).toBe("completed");
    } finally { runs.close(); }
  });
  it("streams text/thinking, replaces partial answers, and reports tool completion without duplicate messages", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const end = new Promise<void>(resolve => { finish = resolve; });
    const factory: ClaudeRunner = () => Object.assign((async function* () {
      yield frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "api-answer" } } });
      yield frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "公开思考" } } });
      yield frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "你好" } } });
      yield frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "，手机" } } });
      await end;
      yield frame({ type: "assistant", uuid: "final-answer", message: { id: "api-answer", content: [{ type: "text", text: "你好，手机" }, { type: "tool_use", id: "call-1", name: "Read", input: { path: "test.txt" } }] } });
      yield frame({ type: "user", uuid: "tool-answer", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "file content" }] } });
      yield result();
    })(), { close: vi.fn() });
    const invalidate = vi.fn();
    const runs = new ClaudeRuns(find, invalidate, factory, async () => new Set());
    const updates: ClaudeRunSnapshot[] = [];
    const unsubscribe = runs.subscribe(run => updates.push(structuredClone(run)));
    try {
      await runs.send(sessionId, "test", randomUUID());
      await vi.advanceTimersByTimeAsync(200);
      expect(JSON.stringify(updates.at(-1))).toContain("你好，手机");
      expect(JSON.stringify(updates.at(-1))).toContain("公开思考");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      const snapshot = runs.snapshots()[0]!;
      expect(snapshot).toMatchObject({ status: "completed", approvals: [] });
      expect(snapshot.messages.map(message => message.id)).not.toContain("api-answer");
      expect(snapshot.messages.find(message => message.id === "final-answer")!.items[1]).toMatchObject({ toolUseId: "call-1", status: "completed" });
      expect(snapshot.finishedAt).not.toBeNull();
      expect(invalidate).toHaveBeenCalledWith(sessionId);
    } finally { unsubscribe(); runs.close(); }
  });

  it("deduplicates submissions, isolates four sessions, blocks a fifth and stops only the selected runner", async () => {
    const { runner, closed } = pendingRunner();
    const runs = new ClaudeRuns(find, vi.fn(), runner, async () => new Set());
    const requestId = randomUUID();
    try {
      const first = await runs.send(sessionId, "one", requestId);
      expect(await runs.send(sessionId, "one", requestId)).toBe(first);
      await expect(runs.send(sessionId, "different", requestId)).rejects.toMatchObject({ statusCode: 409 });
      await expect(runs.send(sessionId, "two", randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      for (let index = 0; index < 3; index++) await runs.send(randomUUID(), "parallel", randomUUID());
      await expect(runs.send(randomUUID(), "fifth", randomUUID())).rejects.toMatchObject({ statusCode: 429 });
      expect(runner).toHaveBeenCalledTimes(4);
      expect(() => runs.stop(sessionId, randomUUID())).toThrow("运行记录已变化");
      runs.stop(sessionId, requestId);
      await vi.waitFor(() => expect(first.status).toBe("stopped"));
      expect(runs.snapshots().filter(run => run.finishedAt === null)).toHaveLength(3);
      expect(closed).toHaveBeenCalled();
    } finally { runs.close(); }
  });

  it("refuses an interactive terminal's session before spawning anything", async () => {
    const { runner } = pendingRunner();
    const runs = new ClaudeRuns(find, vi.fn(), runner, async () => new Set([sessionId]));
    await expect(runs.send(sessionId, "do not send", randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect(runner).not.toHaveBeenCalled();
    expect(await runs.statuses()).toEqual(new Map([[sessionId, "external"]]));
  });

  it("does not let a delayed HTTP response overwrite newer streaming state", () => {
    const newer: ClaudeRunSnapshot = { sessionId, requestId: randomUUID(), revision: 5, status: "completed", messages: [], approvals: [], error: null, startedAt: 100, finishedAt: 200 };
    const current = { [sessionId]: newer };
    expect(mergeClaudeRun(current, { ...newer, revision: 2, status: "running", finishedAt: null })).toBe(current);
    expect(mergeClaudeRun(current, { ...newer, requestId: randomUUID(), startedAt: 50 })).toBe(current);
    expect(mergeClaudeRun(current, { ...newer, requestId: randomUUID(), startedAt: 201, revision: 0, finishedAt: null })[sessionId]!.finishedAt).toBeNull();
  });

  it("requires an explicit scoped approval, redacts inputs, answers questions and rejects stale approvals", async () => {
    let permission: unknown;
    let answer: unknown;
    const factory: ClaudeRunner = (_id, _cwd, _text, controller, canUseTool) => Object.assign((async function* () {
      const options = { signal: controller.signal, toolUseID: "call-1", requestId: "permission-1" } as Parameters<CanUseTool>[2];
      permission = await canUseTool("Bash", { command: "echo mobile", api_key: "DO_NOT_EXPORT" }, options);
      answer = await canUseTool("AskUserQuestion", { questions: [{ question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] }, options);
      yield result();
    })(), { close: vi.fn() });
    const runs = new ClaudeRuns(find, vi.fn(), factory, async () => new Set());
    const requestId = randomUUID();
    try {
      const run = await runs.send(sessionId, "test approvals", requestId);
      await vi.waitFor(() => expect(run.approvals).toHaveLength(1));
      expect(JSON.stringify(run)).not.toContain("DO_NOT_EXPORT");
      expect(permission).toBeUndefined();
      const first = run.approvals[0]!.id;
      runs.decide(sessionId, requestId, first, true);
      await vi.waitFor(() => expect(run.approvals[0]?.tool).toBe("AskUserQuestion"));
      expect(permission).toMatchObject({ behavior: "allow", updatedInput: { command: "echo mobile" } });
      expect(permission).not.toHaveProperty("updatedPermissions");
      expect(() => runs.decide(sessionId, requestId, first, true)).toThrow("审批已结束");
      const second = run.approvals[0]!.id;
      expect(() => runs.decide(sessionId, requestId, second, true)).toThrow("回答所有问题");
      runs.decide(sessionId, requestId, second, true, { "选哪个？": "B" });
      await vi.waitFor(() => expect(run.status).toBe("completed"));
      expect(answer).toMatchObject({ behavior: "allow", updatedInput: { answers: { "选哪个？": "B" } } });
    } finally { runs.close(); }
  });

  it("exposes real execution errors and releases pending approvals on stop", async () => {
    const denied = vi.fn();
    const factory: ClaudeRunner = (_id, _cwd, _text, controller, canUseTool) => Object.assign((async function* () {
      denied(await canUseTool("Write", { path: "test.txt" }, { signal: controller.signal } as Parameters<CanUseTool>[2]));
      throw new Error("502 Bad Gateway: service busy");
    })(), { close: vi.fn() });
    const runs = new ClaudeRuns(find, vi.fn(), factory, async () => new Set());
    const requestId = randomUUID();
    const run = await runs.send(sessionId, "stop me", requestId);
    await vi.waitFor(() => expect(run.status).toBe("approval"));
    runs.stop(sessionId, requestId);
    await vi.waitFor(() => expect(run.status).toBe("stopped"));
    expect(denied).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
    expect(run.approvals).toEqual([]);
    const failure = await runs.send(sessionId, "fail me", randomUUID());
    await vi.waitFor(() => expect(failure.status).toBe("approval"));
    runs.decide(sessionId, failure.requestId, failure.approvals[0]!.id, false);
    await vi.waitFor(() => expect(failure.status).toBe("failed"));
    expect(failure.error).toContain("502 Bad Gateway: service busy");
    runs.close();
  });

  it("validates writes and blocks missing auth/cross-origin access at both service boundaries", async () => {
    const key = "k".repeat(64);
    const { runner } = pendingRunner();
    const runs = new ClaudeRuns(find, vi.fn(), runner, async () => new Set());
    const backend = createClaudeBackend(key, new ClaudeSessionStore(), runs);
    const gateway = Fastify();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    registerClaudeProxy(gateway, async (request, reply) => { if (request.headers.cookie !== "valid") await reply.code(401).send({ error: "unauthorized" }); }, "s".repeat(32), transport);
    try {
      const url = `/sessions/${sessionId}/messages`;
      const payload = { text: "hello", requestId: randomUUID() };
      const headers = { host: "127.0.0.1:4600", "x-codex-mobile-claude-key": key };
      expect((await backend.inject({ method: "POST", url, payload })).statusCode).toBe(403);
      expect((await backend.inject({ method: "POST", url, headers: { host: headers.host }, payload })).statusCode).toBe(401);
      expect((await backend.inject({ method: "POST", url, headers: { ...headers, origin: "http://evil.example" }, payload })).statusCode).toBe(403);
      expect((await backend.inject({ method: "POST", url, headers, payload: { ...payload, requestId: "invalid" } })).statusCode).toBe(400);
      expect(runner).not.toHaveBeenCalled();
      expect((await backend.inject({ method: "GET", url: `/sessions/${sessionId}/settings`, headers: { host: headers.host } })).statusCode).toBe(401);
      const settingsResponse = await backend.inject({ method: "GET", url: `/sessions/${sessionId}/settings`, headers });
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toHaveProperty("effective");
      const gatewayUrl = `/api/claude${url}`;
      const browserHeaders = { cookie: "valid", origin: "http://localhost:80" };
      expect((await gateway.inject({ method: "POST", url: gatewayUrl, payload })).statusCode).toBe(401);
      expect((await gateway.inject({ method: "POST", url: gatewayUrl, headers: { cookie: "valid", origin: "http://evil.example" }, payload })).statusCode).toBe(403);
      expect((await gateway.inject({ method: "POST", url: gatewayUrl, headers: browserHeaders, payload: { ...payload, extra: "field" } })).statusCode).toBe(400);
      expect(transport).not.toHaveBeenCalled();
      expect((await gateway.inject({ method: "POST", url: gatewayUrl, headers: browserHeaders, payload: { ...payload, options: { permissionMode: "dontAsk" } } })).statusCode).toBe(400);
      expect((await gateway.inject({ method: "POST", url: gatewayUrl, headers: browserHeaders, payload })).statusCode).toBe(200);
      expect(transport.mock.calls[0]![1]!.method).toBe("POST");
      expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toEqual(payload);
    } finally { await gateway.close(); await backend.close(); }
  });

  it("streams through the authenticated gateway and restores current state on reconnect without starting a runner", async () => {
    const key = "k".repeat(64);
    const { runner } = pendingRunner();
    const runs = new ClaudeRuns(find, vi.fn(), runner, async () => new Set());
    const backend = createClaudeBackend(key, new ClaudeSessionStore(), runs);
    const backendAddress = await backend.listen({ host: "127.0.0.1", port: 0 });
    const gateway = Fastify();
    const transport: typeof fetch = (input, options) => new Promise((resolve, reject) => {
      const path = new URL(String(input)).pathname;
      const upstream = httpRequest(backendAddress + path, { headers: { host: "127.0.0.1:4600", "x-codex-mobile-claude-key": key }, signal: options?.signal || undefined }, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode || 500, headers }));
      });
      upstream.on("error", reject);
      upstream.end();
    });
    registerClaudeProxy(gateway, async () => {}, "s".repeat(32), transport);
    const gatewayAddress = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const requestId = randomUUID();
    try {
      const response = await fetch(`${gatewayAddress}/api/claude/events`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"runs":[]');
      await runs.send(sessionId, "stream test", requestId);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(requestId);
      await reader.cancel();
      const reconnect = await fetch(`${gatewayAddress}/api/claude/events`);
      const reconnectReader = reconnect.body!.getReader();
      expect(new TextDecoder().decode((await reconnectReader.read()).value)).toContain(requestId);
      expect(runner).toHaveBeenCalledTimes(1);
      await reconnectReader.cancel();
    } finally {
      // The test's HTTP/WebStream adapter owns sockets outside fetch's normal cancellation path.
      gateway.server.closeAllConnections();
      backend.server.closeAllConnections();
      await gateway.close();
      await backend.close();
    }
    expect(runs.snapshots()[0]!.status).toBe("stopped");
  });
});
