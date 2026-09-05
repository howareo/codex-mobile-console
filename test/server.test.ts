import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AppServerClient } from "../src/protocol/app-server-client.js";
import { backgroundSnapshotCapacity, createGatewayApp } from "../src/server/app.js";
import type { GatewayConfig } from "../src/server/config.js";
import { GatewayLogger, RollingGatewayMetrics } from "../src/server/diagnostics.js";
import { SessionStore } from "../src/server/sessions.js";
import type { ModelListResult, RpcId, ThreadSummary, TurnInput } from "../src/shared/types.js";

class MockUpstream extends EventEmitter {
  public readonly initializeResult = { platformOs: "windows" };
  public readonly calls: Array<{ method: string; params: unknown }> = [];
  public listCalls = 0;
  public readonly pageCalls: Array<{ threadId: string; cursor: string | null; limit: number }> = [];
  public readonly responses: Array<{ id: RpcId; result: unknown }> = [];
  public turns: unknown[] = [];
  public startError: Error | null = null;
  public startErrors: Error[] = [];
  public readonly metadataReads: Array<{ threadId: string; priority: "foreground" | "background" }> = [];
  public threadListData: ThreadSummary[] = [];
  public threadPages = new Map<string | null, { data: ThreadSummary[]; nextCursor: string | null }>();
  public modelPages = new Map<string | null, ModelListResult>();
  public loadedThreadPages: Array<{ cursor: string | null; data: string[]; nextCursor: string | null }> = [{ cursor: null, data: [], nextCursor: null }];

  public async listModels(cursor: string | null = null): Promise<ModelListResult> {
    this.calls.push({ method: "model/list", params: { cursor, limit: 100, includeHidden: false } });
    const paged = this.modelPages.get(cursor);
    if (paged) return paged;
    return {
      data: [
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "default", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }, { reasoningEffort: "high", description: "deep" }], serviceTiers: [] },
        { id: "gpt-session", model: "gpt-session", displayName: "Session Model", description: "thread setting", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "balanced" }], serviceTiers: [] }
      ],
      nextCursor: null
    };
  }

  public async listThreads(cursor: string | null = null): Promise<{ data: ThreadSummary[]; nextCursor: string | null }> {
    this.listCalls++;
    this.calls.push({ method: "thread/list", params: { cursor, limit: 50 } });
    const paged = this.threadPages.get(cursor);
    if (paged) return paged;
    return { data: this.threadListData, nextCursor: null };
  }

  public async listLoadedThreads(cursor: string | null = null): Promise<{ data: string[]; nextCursor: string | null }> {
    this.calls.push({ method: "thread/loaded/list", params: { cursor, limit: 100 } });
    return this.loadedThreadPages.find(page => page.cursor === cursor) ?? { data: [], nextCursor: null };
  }

  public async listThreadTurns(threadId: string, cursor: string | null, limit: number): Promise<{ data: unknown[]; nextCursor: string | null; backwardsCursor: string | null }> {
    this.pageCalls.push({ threadId, cursor, limit });
    const end = cursor ? Number(cursor.slice("cursor-".length)) : this.turns.length;
    const start = Math.max(0, end - limit);
    return {
      data: this.turns.slice(start, end).reverse(),
      nextCursor: start > 0 ? `cursor-${start}` : null,
      backwardsCursor: `back-${end}`
    };
  }

  public resumeSettings: { model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null } = { model: "gpt-session", modelProvider: "openai", reasoningEffort: "medium" };
  public threadStatus: unknown = "running";
  public onStartTurn: (() => void) | null = null;
  public unsubscribeGate: Promise<void> | null = null;
  public unsubscribeError: Error | null = null;
  public unsubscribeFailuresRemaining = 0;
  public unsubscribeAlwaysError = false;

  public async readThreadMetadata(threadId: string, priority: "foreground" | "background" = "foreground"): Promise<{ thread: { id: string }; model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null }> {
    this.metadataReads.push({ threadId, priority });
    this.calls.push({ method: "thread/read", params: { threadId, includeTurns: false } });
    return { thread: { id: threadId, status: this.threadStatus }, ...this.resumeSettings };
  }

  public async startTurn(threadId: string, input: string | TurnInput[], settings: { model?: string | null; effort?: string | null } = {}): Promise<{ turn: { id: string } }> {
    this.calls.push({ method: "turn/start", params: { threadId, ...(typeof input === "string" ? { text: input } : { input }), ...settings } });
    const error = this.startErrors.shift() ?? this.startError;
    if (error) throw error;
    this.onStartTurn?.();
    return { turn: { id: "turn-new" } };
  }

  // 模拟共享 app-server 将持久化任务恢复到内存，但不返回完整历史。
  public async resumeThread(threadId: string): Promise<{ thread: { id: string }; model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null }> {
    this.calls.push({ method: "thread/resume", params: { threadId, excludeTurns: true } });
    return { thread: { id: threadId }, ...this.resumeSettings };
  }

  public async unsubscribeThread(threadId: string): Promise<{ status: "unsubscribed" }> {
    this.calls.push({ method: "thread/unsubscribe", params: { threadId } });
    if (this.unsubscribeGate) await this.unsubscribeGate;
    if (this.unsubscribeFailuresRemaining > 0) {
      this.unsubscribeFailuresRemaining--;
      throw this.unsubscribeError ?? new Error("temporary unsubscribe failure");
    }
    if (this.unsubscribeAlwaysError && this.unsubscribeError) throw this.unsubscribeError;
    return { status: "unsubscribed" };
  }

  public async steerTurn(threadId: string, turnId: string, input: string | TurnInput[]): Promise<{ turnId: string }> {
    this.calls.push({ method: "turn/steer", params: { threadId, turnId, ...(typeof input === "string" ? { text: input } : { input }) } });
    return { turnId };
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    this.calls.push({ method: "turn/interrupt", params: { threadId, turnId } });
    return {};
  }

  public respondToServerRequest(id: RpcId, result: unknown): void {
    this.responses.push({ id, result });
  }
}

describe("authenticated phase-2 gateway", () => {
  let app: Awaited<ReturnType<typeof createGatewayApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires login for sending, interrupting, and responding to approvals", async () => {
    const secret = "s".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);

    const rejected = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns", payload: { text: "hello" } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(rejected.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");
    expect(rejected.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(rejected.headers["referrer-policy"]).toBe("no-referrer");
    expect(rejected.headers["x-content-type-options"]).toBe("nosniff");
    expect(rejected.headers["x-frame-options"]).toBe("DENY");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    const sessionStatus = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    expect(sessionStatus.statusCode).toBe(200);
    expect(sessionStatus.json()).toMatchObject({ ok: true, epoch: expect.any(String), expiresAt: expect.any(Number) });
    expect(upstream.listCalls).toBe(0);

    const concurrentLists = await Promise.all([1, 2, 3, 4].map(() => app!.inject({ method: "GET", url: "/api/threads", headers: { cookie } })));
    expect(concurrentLists.map(response => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect(upstream.listCalls).toBe(1);

    const modelLists = await Promise.all([1, 2, 3].map(() => app!.inject({ method: "GET", url: "/api/models", headers: { cookie } })));
    expect(modelLists.map(response => response.statusCode)).toEqual([200, 200, 200]);
    expect(modelLists[0]!.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" })]) });
    expect(upstream.calls.filter(call => call.method === "model/list")).toHaveLength(1);

    upstream.turns = Array.from({ length: 15 }, (_, index) => ({ id: `turn-${index}`, items: [{ id: `item-${index}`, type: "commandExecution", command: "test", aggregatedOutput: "x".repeat(5000) }] }));
    const latestPage = await app.inject({ method: "GET", url: "/api/threads/thread-1", headers: { cookie } });
    const latestBody = latestPage.json();
    expect(latestBody.history).toEqual({ kind: "head", olderCursor: "cursor-5", hasOlder: true });
    expect(latestBody.thread.turns).toHaveLength(10);
    expect(latestBody.thread.turns[0]).toMatchObject({ id: "turn-5" });
    expect(latestBody.thread.turns[0].items[0].output.length).toBeLessThan(700);
    expect(latestBody.thread).toEqual(expect.objectContaining({ id: "thread-1", turns: expect.any(Array) }));
    expect(latestBody.thread).not.toHaveProperty("model");
    expect(upstream.metadataReads).toHaveLength(0);
    const olderPage = await app.inject({ method: "GET", url: "/api/threads/thread-1?cursor=cursor-5", headers: { cookie } });
    const olderBody = olderPage.json();
    expect(olderBody.history).toEqual({ kind: "older", olderCursor: null, hasOlder: false });
    expect(olderBody.thread.turns).toHaveLength(5);
    expect(olderBody.thread.turns[0]).toMatchObject({ id: "turn-0" });
    expect(upstream.metadataReads).toHaveLength(0);
    expect(upstream.pageCalls).toEqual([
      { threadId: "thread-1", cursor: null, limit: 10 },
      { threadId: "thread-1", cursor: "cursor-5", limit: 10 }
    ]);

    const diagnostic = await app.inject({ method: "POST", url: "/api/diagnostics/client", headers: { cookie }, payload: { level: "warn", event: "ws.closed", details: { code: 1006 } } });
    expect(diagnostic.statusCode).toBe(204);
    const diagnosticStatus = await app.inject({ method: "GET", url: "/api/diagnostics/status", headers: { cookie } });
    expect(diagnosticStatus.json()).toMatchObject({
      upstream: { state: "unknown", pendingRequests: 0 },
      realtime: { mode: "adaptive" },
      stability: { upstream: { requests: 0 }, snapshots: { runs: 0 }, reconnects: 0 },
      log: { enabled: false }
    });

    const requestId = "send-thread-1-0001";
    const started = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns", headers: { cookie }, payload: { text: "hello", requestId } });
    expect(started.json()).toMatchObject({ requestId, mode: "start", turn: { id: "turn-new" } });

    const duplicate = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns", headers: { cookie }, payload: { text: "hello", requestId } });
    expect(duplicate.json()).toEqual(started.json());
    expect(upstream.calls.filter(call => call.method === "turn/start" && (call.params as { threadId: string }).threadId === "thread-1")).toHaveLength(1);

    const sameThreadStart = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns", headers: { cookie }, payload: { text: "follow up", requestId: "send-thread-1-0002" } });
    expect(sameThreadStart.statusCode).toBe(200);
    expect(upstream.calls.filter(call => call.method === "thread/resume" && (call.params as { threadId: string }).threadId === "thread-1")).toHaveLength(1);
    expect(upstream.calls.filter(call => call.method === "turn/start" && (call.params as { threadId: string }).threadId === "thread-1")).toHaveLength(2);

    // 四个不同任务必须并行通过只读设置检查和启动流程，不设置全局任务数量上限。
    const concurrentStarts = await Promise.all([2, 3, 4, 5].map(index => app!.inject({ method: "POST", url: `/api/threads/thread-${index}/turns`, headers: { cookie }, payload: { text: `hello-${index}` } })));
    expect(concurrentStarts.map(response => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect(concurrentStarts.map(response => response.json().mode)).toEqual(["start", "start", "start", "start"]);

    const selectedModel = await app.inject({ method: "POST", url: "/api/threads/thread-6/turns", headers: { cookie }, payload: { text: "use model", model: "gpt-5.6-sol", reasoningEffort: "high", requestId: "model-thread-6" } });
    expect(selectedModel.statusCode).toBe(200);
    expect(selectedModel.json()).toMatchObject({ mode: "start", model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(upstream.calls).not.toContainEqual(expect.objectContaining({ method: "thread/settings/update" }));
    expect(upstream.calls).toContainEqual({ method: "turn/start", params: { threadId: "thread-6", text: "use model", model: "gpt-5.6-sol", effort: "high" } });

    const inheritedEffort = await app.inject({ method: "POST", url: "/api/threads/thread-9/turns", headers: { cookie }, payload: { text: "keep session model", reasoningEffort: "medium", requestId: "effort-thread-9" } });
    expect(inheritedEffort.statusCode).toBe(200);
    expect(upstream.calls).toContainEqual({ method: "turn/start", params: { threadId: "thread-9", text: "keep session model", effort: "medium" } });

    const defaultStart = await app.inject({ method: "POST", url: "/api/threads/thread-10/turns", headers: { cookie }, payload: { text: "use session", requestId: "session-thread-10" } });
    expect(defaultStart.statusCode).toBe(200);
    expect(upstream.calls).toContainEqual({ method: "turn/start", params: { threadId: "thread-10", text: "use session" } });

    const desktopRunningSteer = await app.inject({ method: "POST", url: "/api/threads/thread-desktop-running/turns", headers: { cookie }, payload: { text: "join desktop task", activeTurnId: "turn-desktop", requestId: "desktop-steer-0001" } });
    expect(desktopRunningSteer.statusCode).toBe(200);
    expect(upstream.calls.filter(call => call.method === "thread/resume" && (call.params as { threadId: string }).threadId === "thread-desktop-running")).toHaveLength(1);
    expect(upstream.calls).toContainEqual({ method: "turn/steer", params: { threadId: "thread-desktop-running", turnId: "turn-desktop", text: "join desktop task" } });

    const invalidModel = await app.inject({ method: "POST", url: "/api/threads/thread-7/turns", headers: { cookie }, payload: { text: "bad model", model: "missing-model", requestId: "model-thread-7" } });
    expect(invalidModel.statusCode).toBe(400);

    const invalidEffort = await app.inject({ method: "POST", url: "/api/threads/thread-8/turns", headers: { cookie }, payload: { text: "bad effort", model: "gpt-5.6-sol", reasoningEffort: "ultra", requestId: "effort-thread-8" } });
    expect(invalidEffort.statusCode).toBe(400);

    const effortUnsupportedBySession = await app.inject({ method: "POST", url: "/api/threads/thread-11/turns", headers: { cookie }, payload: { text: "wrong session effort", reasoningEffort: "high", requestId: "effort-thread-11" } });
    expect(effortUnsupportedBySession.statusCode).toBe(400);

    upstream.startError = Object.assign(new Error("unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses"), { statusCode: 502 });
    const upstreamFailure = await app.inject({ method: "POST", url: "/api/threads/thread-12/turns", headers: { cookie }, payload: { text: "video", requestId: "upstream-failure-12" } });
    expect(upstreamFailure.statusCode).toBe(502);
    expect(upstreamFailure.json()).toEqual({ error: "unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses", status: 502 });
    upstream.startError = null;

    const steerRequestId = "steer-thread-1-0001";
    const steered = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns", headers: { cookie }, payload: { text: "more", activeTurnId: "turn-1", requestId: steerRequestId } });
    expect(steered.json()).toMatchObject({ requestId: steerRequestId, mode: "steer", turnId: "turn-1" });

    const interrupted = await app.inject({ method: "POST", url: "/api/threads/thread-1/turns/turn-1/interrupt", headers: { cookie } });
    expect(interrupted.json()).toEqual({ ok: true });

    upstream.emit("serverRequest", {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1 }
    });
    const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers: { cookie } });
    expect(approvals.json()).toMatchObject({ data: [{ id: "approval-1" }] });

    const approved = await app.inject({ method: "POST", url: "/api/approvals/approval-1", headers: { cookie }, payload: { decision: "accept" } });
    expect(approved.json()).toEqual({ ok: true });
    expect(upstream.responses).toEqual([{ id: "approval-1", result: { decision: "accept" } }]);
    expect(upstream.calls.filter(call => call.method === "thread/resume").map(call => (call.params as { threadId: string }).threadId).sort()).toEqual(["thread-1", "thread-10", "thread-12", "thread-2", "thread-3", "thread-4", "thread-5", "thread-6", "thread-9", "thread-desktop-running"]);
    expect(upstream.metadataReads.filter(read => read.priority === "foreground")).toHaveLength(13);
    expect(upstream.calls.filter(call => call.method === "turn/start").map(call => (call.params as { threadId: string }).threadId).sort()).toEqual(["thread-1", "thread-1", "thread-10", "thread-12", "thread-2", "thread-3", "thread-4", "thread-5", "thread-6", "thread-9"]);
    expect(upstream.calls.filter(call => call.method === "turn/steer" || call.method === "turn/interrupt").map(call => call.method)).toEqual(["turn/steer", "turn/steer", "turn/interrupt"]);
  });

  it("uploads authenticated images and sends localImage input without exposing arbitrary files", async () => {
    const secret = "i".repeat(32);
    const uploadRoot = await mkdtemp(join(tmpdir(), "codex-mobile-images-"));
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null,
      imageUploadRoot: uploadRoot
    };
    try {
      app = await createGatewayApp(config, upstream as unknown as AppServerClient);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const rejected = await app.inject({ method: "POST", url: "/api/images", headers: { "content-type": "image/png" }, payload: png });
      expect(rejected.statusCode).toBe(401);

      const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
      const invalid = await app.inject({ method: "POST", url: "/api/images", headers: { cookie, "content-type": "image/jpeg" }, payload: png });
      expect(invalid.statusCode).toBe(415);

      const uploaded = await app.inject({ method: "POST", url: "/api/images", headers: { cookie, "content-type": "image/png" }, payload: png });
      expect(uploaded.statusCode).toBe(201);
      const imageId = uploaded.json().imageId as string;
      expect(imageId).toMatch(/\.png$/);
      const fetched = await app.inject({ method: "GET", url: `/api/images/${imageId}`, headers: { cookie } });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.headers["content-type"]).toContain("image/png");
      expect(fetched.rawPayload).toEqual(png);

      const imageOnly = await app.inject({ method: "POST", url: "/api/threads/thread-image/turns", headers: { cookie }, payload: { images: [imageId], requestId: "image-only-turn-0001" } });
      expect(imageOnly.statusCode).toBe(200);
      expect(upstream.calls).toContainEqual({
        method: "turn/start",
        params: { threadId: "thread-image", input: [{ type: "localImage", path: join(uploadRoot, imageId), detail: "auto" }] }
      });
      upstream.turns = [{ id: "turn-image", items: [{ id: "user-image", type: "userMessage", content: [{ type: "localImage", path: join(uploadRoot, imageId), detail: "auto" }] }] }];
      const history = await app.inject({ method: "GET", url: "/api/threads/thread-image", headers: { cookie } });
      expect(history.json().thread.turns[0].items[0].content).toEqual([{ type: "localImage", path: imageId, detail: "auto" }]);

      const missing = await app.inject({ method: "POST", url: "/api/threads/thread-image/turns", headers: { cookie }, payload: { images: ["00000000-0000-4000-8000-000000000000.png"], requestId: "missing-image-0001" } });
      expect(missing.statusCode).toBe(400);
      const traversal = await app.inject({ method: "GET", url: "/api/images/not-an-upload.png", headers: { cookie } });
      expect(traversal.statusCode).toBe(404);
    } finally {
      await app?.close();
      app = undefined;
      await rm(uploadRoot, { recursive: true, force: true });
    }
  });

  it("reads persisted task parameters through the authenticated on-demand route", async () => {
    const secret = "m".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);

    const rejected = await app.inject({ method: "GET", url: "/api/threads/thread-settings/metadata" });
    expect(rejected.statusCode).toBe(401);
    expect(upstream.metadataReads).toEqual([]);

    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    upstream.resumeSettings = { model: "gpt-session", modelProvider: "openai", reasoningEffort: "medium" };
    const response = await app.inject({ method: "GET", url: "/api/threads/thread-settings/metadata", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "thread-settings", model: "gpt-session", modelProvider: "openai", reasoningEffort: "medium" });
    expect(upstream.metadataReads).toEqual([{ threadId: "thread-settings", priority: "foreground" }]);
    expect(upstream.calls.filter(call => call.method === "thread/resume")).toEqual([]);
  });

  it("only resumes once after turn/start explicitly reports a missing thread", async () => {
    const secret = "n".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    upstream.startErrors.push(new Error("-32001: thread thread-missing was not found"));
    const recovered = await app.inject({ method: "POST", url: "/api/threads/thread-missing/turns", headers: { cookie }, payload: { text: "retry after load", requestId: "missing-thread-0001" } });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ mode: "start", recovered: true, model: "gpt-session", reasoningEffort: "medium" });
    expect(upstream.metadataReads.filter(read => read.priority === "foreground")).toEqual([
      { threadId: "thread-missing", priority: "foreground" }
    ]);
    expect(upstream.calls.filter(call => call.method === "thread/resume")).toEqual([
      { method: "thread/resume", params: { threadId: "thread-missing", excludeTurns: true } },
      { method: "thread/resume", params: { threadId: "thread-missing", excludeTurns: true } }
    ]);
    expect(upstream.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
  });

  it("does not add a missing-thread resume or retry after an upstream 502", async () => {
    const secret = "f".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    upstream.startError = Object.assign(new Error("unexpected status 502 Bad Gateway"), { statusCode: 502 });
    const failed = await app.inject({ method: "POST", url: "/api/threads/thread-502/turns", headers: { cookie }, payload: { text: "do not retry", requestId: "upstream-502-0001" } });

    expect(failed.statusCode).toBe(502);
    expect(upstream.calls.filter(call => call.method === "thread/resume")).toHaveLength(1);
    expect(upstream.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  it("unsubscribes an idle thread recovered by this gateway when the phone returns to the list", async () => {
    const secret = "u".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    upstream.startErrors.push(new Error("-32001: thread thread-idle was not found"));
    await app.inject({ method: "POST", url: "/api/threads/thread-idle/turns", headers: { cookie }, payload: { text: "recover", requestId: "idle-thread-0001" } });
    const socket = new WebSocket(`${address.replace("http://", "ws://")}/api/events`, { headers: { cookie } });
    await once(socket, "open");
    socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId: "thread-idle" } }));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(upstream.pageCalls).toHaveLength(0);
    upstream.threadStatus = "idle";
    socket.send(JSON.stringify({ method: "thread/unsubscribe", params: {} }));
    await expect.poll(() => upstream.calls.some(call => call.method === "thread/unsubscribe" && (call.params as { threadId: string }).threadId === "thread-idle"), { timeout: 500 }).toBe(true);
    socket.close();
    await once(socket, "close");
  });

  it("stops repeated list cursors instead of looping forever", async () => {
    const secret = "c".repeat(32);
    const upstream = new MockUpstream();
    upstream.threadPages.set(null, { data: [], nextCursor: "same" });
    upstream.threadPages.set("same", { data: [], nextCursor: "same" });
    const config: GatewayConfig = { appServerUrl: "ws://127.0.0.1:4500", pairingSecret: secret, host: "127.0.0.1", port: 4174, staticRoot: "C:\\missing-codex-mobile-static-root", logFile: null, sessionTtlMs: 60_000, sessionStoreFile: null };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const response = await app.inject({ method: "GET", url: "/api/threads", headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain("重复游标");
    expect(upstream.calls.filter(call => call.method === "thread/list")).toHaveLength(2);
  });

  it("retries a transient idle unsubscribe and exposes final failures", async () => {
    const secret = "y".repeat(32);
    const upstream = new MockUpstream();
    upstream.threadStatus = "idle";
    upstream.unsubscribeFailuresRemaining = 2;
    const config: GatewayConfig = { appServerUrl: "ws://127.0.0.1:4500", pairingSecret: secret, host: "127.0.0.1", port: 4174, staticRoot: "C:\\missing-codex-mobile-static-root", logFile: null, sessionTtlMs: 60_000, sessionStoreFile: null };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    await app.inject({ method: "POST", url: "/api/threads/thread-retry/turns", headers: { cookie }, payload: { text: "retry", requestId: "retry-thread-0001" } });
    await expect.poll(() => upstream.calls.filter(call => call.method === "thread/unsubscribe")).toHaveLength(3);
    const status = await app.inject({ method: "GET", url: "/api/diagnostics/status", headers: { cookie } });
    expect(status.json().unsubscribeFailures).toEqual([]);
  });

  it("treats repeated realtime subscriptions for one task as idempotent", async () => {
    const secret = "d".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const socket = new WebSocket(`${address.replace("http://", "ws://")}/api/events`, { headers: { cookie } });
    await once(socket, "open");
    socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId: "thread-duplicate" } }));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(upstream.pageCalls).toHaveLength(0);
    socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId: "thread-duplicate" } }));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(upstream.pageCalls).toHaveLength(0);
    socket.close();
    await once(socket, "close");
  });

  it("coalesces subscribed realtime notifications into one detail read", async () => {
    const secret = "e".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const socket = new WebSocket(`${address.replace("http://", "ws://")}/api/events`, { headers: { cookie } });
    await once(socket, "open");
    socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId: "thread-event" } }));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(upstream.pageCalls).toHaveLength(0);

    upstream.emit("notification", { method: "thread/status/changed", params: { threadId: "thread-event", status: "running" } });
    upstream.emit("notification", { method: "turn/started", params: { threadId: "thread-event", turnId: "turn-1" } });
    upstream.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-event", turnId: "turn-1" } });
    await expect.poll(() => upstream.pageCalls.filter(call => call.threadId === "thread-event"), { timeout: 1_000 }).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(upstream.pageCalls.filter(call => call.threadId === "thread-event")).toHaveLength(1);
    socket.close();
    await once(socket, "close");
  });

  it("releases an idle mobile task after interrupt completes", async () => {
    const secret = "i".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    await app.inject({ method: "POST", url: "/api/threads/thread-interrupt/turns", headers: { cookie }, payload: { text: "start", requestId: "interrupt-start-0001" } });
    upstream.threadStatus = "idle";

    const interrupted = await app.inject({ method: "POST", url: "/api/threads/thread-interrupt/turns/turn-1/interrupt", headers: { cookie } });

    expect(interrupted.statusCode).toBe(200);
    await expect.poll(() => upstream.calls.some(call => call.method === "thread/unsubscribe" && (call.params as { threadId: string }).threadId === "thread-interrupt"), { timeout: 500 }).toBe(true);
  });

  it("releases a completed task when its idle notification arrives before the write finishes", async () => {
    const secret = "z".repeat(32);
    const upstream = new MockUpstream();
    upstream.threadStatus = "idle";
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    upstream.onStartTurn = () => upstream.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thread-completes-fast", status: "idle" }
    });

    const started = await app.inject({ method: "POST", url: "/api/threads/thread-completes-fast/turns", headers: { cookie }, payload: { text: "quick task", requestId: "fast-thread-0001" } });

    expect(started.statusCode).toBe(200);
    await expect.poll(() => upstream.calls.some(call => call.method === "thread/unsubscribe" && (call.params as { threadId: string }).threadId === "thread-completes-fast"), { timeout: 500 }).toBe(true);
  });

  it("resumes again when a new write arrives while an idle unsubscribe is pending", async () => {
    const secret = "q".repeat(32);
    const upstream = new MockUpstream();
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

    await app.inject({ method: "POST", url: "/api/threads/thread-race/turns", headers: { cookie }, payload: { text: "first", requestId: "race-thread-0001" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    upstream.threadStatus = "idle";
    let releaseUnsubscribe: () => void = () => undefined;
    upstream.unsubscribeGate = new Promise<void>(resolve => {
      releaseUnsubscribe = resolve;
    });
    upstream.emit("notification", { method: "thread/status/changed", params: { threadId: "thread-race", status: "idle" } });
    await expect.poll(() => upstream.calls.filter(call => call.method === "thread/unsubscribe" && (call.params as { threadId: string }).threadId === "thread-race")).toHaveLength(1);

    const followUp = app.inject({ method: "POST", url: "/api/threads/thread-race/turns", headers: { cookie }, payload: { text: "second", requestId: "race-thread-0002" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upstream.calls.filter(call => call.method === "turn/start" && (call.params as { threadId: string }).threadId === "thread-race")).toHaveLength(1);
    releaseUnsubscribe();

    expect((await followUp).statusCode).toBe(200);
    expect(upstream.calls.filter(call => call.method === "thread/resume" && (call.params as { threadId: string }).threadId === "thread-race")).toHaveLength(2);
    expect(upstream.calls.filter(call => call.method === "turn/start" && (call.params as { threadId: string }).threadId === "thread-race")).toHaveLength(2);
  });

  it("persists only HMAC session records and survives a gateway restart", async () => {
    const root = join(tmpdir(), `codex-mobile-sessions-${process.pid}-${Date.now()}`);
    const filePath = join(root, "sessions.json");
    const pairingSecret = "p".repeat(44);
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: filePath
    };
    try {
      const first = await createGatewayApp(config, new MockUpstream() as unknown as AppServerClient);
      const login = await first.inject({ method: "POST", url: "/api/auth/session", payload: { token: pairingSecret } });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
      const rawId = cookie.split("=", 2)[1]!;
      const epoch = login.json().epoch;
      await first.close();

      const persisted = await readFile(filePath, "utf8");
      expect(persisted).not.toContain(rawId);
      expect(persisted).not.toContain(pairingSecret);
      expect(JSON.parse(persisted).sessions[0].digest).toMatch(/^[a-f0-9]{64}$/);

      const second = await createGatewayApp(config, new MockUpstream() as unknown as AppServerClient);
      const restored = await second.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
      expect(restored.json()).toMatchObject({ ok: true, epoch });
      await second.inject({ method: "DELETE", url: "/api/auth/session", headers: { cookie } });
      await second.close();

      const third = await createGatewayApp(config, new MockUpstream() as unknown as AppServerClient);
      expect((await third.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(401);
      await third.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renews active sessions, rejects a changed pairing secret, and tolerates a damaged store", async () => {
    const root = join(tmpdir(), `codex-mobile-session-store-${process.pid}-${Date.now()}`);
    const filePath = join(root, "sessions.json");
    let now = 1_000;
    const secret = "r".repeat(44);
    const errors: string[] = [];
    try {
      const first = await SessionStore.open({ ttlMs: 1_000, pairingSecret: secret, filePath, writeDelayMs: 1, now: () => now });
      const created = first.create();
      await first.flush();
      now = 1_600;
      expect(first.use(created.id)).toMatchObject({ epoch: created.epoch, renewed: true, expiresAt: 2_600 });
      await first.flush();

      const restored = await SessionStore.open({ ttlMs: 1_000, pairingSecret: secret, filePath, now: () => now });
      expect(restored.use(created.id, false)).toMatchObject({ epoch: created.epoch, renewed: false, expiresAt: 2_600 });
      const changedSecret = await SessionStore.open({ ttlMs: 1_000, pairingSecret: "x".repeat(44), filePath, now: () => now });
      expect(changedSecret.use(created.id, false)).toBeNull();

      await writeFile(filePath, "not json", "utf8");
      const recovered = await SessionStore.open({ ttlMs: 1_000, pairingSecret: secret, filePath, now: () => now, onError: event => errors.push(event) });
      expect(recovered.use(created.id, false)).toBeNull();
      expect(errors).toEqual(["sessions.load_failed"]);
      expect(recovered.create().id).toEqual(expect.any(String));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes structured diagnostics while redacting sensitive fields", async () => {
    const path = join(tmpdir(), `codex-mobile-diagnostics-${process.pid}-${Date.now()}.ndjson`);
    const logger = new GatewayLogger(path);
    try {
      logger.error("client.api.response_error", { token: "private", details: { text: "message body", statusCode: 500 }, route: "/api/threads/:threadId" });
      await logger.flush();
      const entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(entry).toMatchObject({ level: "error", event: "client.api.response_error", token: "[redacted]", route: "/api/threads/:threadId" });
      expect(entry.details).toEqual({ text: "[redacted]", statusCode: 500 });
    } finally {
      await rm(path, { force: true });
    }
  });

  it("maps loaded task diagnostics without reading or resuming task details", async () => {
    const secret = "l".repeat(32);
    const upstream = new MockUpstream();
    upstream.threadListData = [
      { id: "thread-mobile", title: "Mobile task", name: "Mobile task", cwd: "C:\\work\\mobile", status: "running" },
      { id: "thread-desktop", title: "Desktop task", name: "Desktop task", cwd: "C:\\work\\desktop", status: "idle" }
    ];
    upstream.loadedThreadPages = [
      { cursor: null, data: ["thread-mobile", "thread-desktop"], nextCursor: "page-2" },
      { cursor: "page-2", data: ["thread-unmapped"], nextCursor: null }
    ];
    const config: GatewayConfig = {
      appServerUrl: "ws://127.0.0.1:4500",
      pairingSecret: secret,
      host: "127.0.0.1",
      port: 4174,
      staticRoot: "C:\\missing-codex-mobile-static-root",
      logFile: null,
      sessionTtlMs: 60_000,
      sessionStoreFile: null
    };
    app = await createGatewayApp(config, upstream as unknown as AppServerClient);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const socket = new WebSocket(`${address.replace("http://", "ws://")}/api/events`, { headers: { cookie } });
    await once(socket, "open");
    socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId: "thread-mobile" } }));
    await new Promise(resolve => setTimeout(resolve, 25));

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/loaded-tasks", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      total: 3,
      data: [
        expect.objectContaining({ id: "thread-mobile", title: "Mobile task", name: "Mobile task", cwd: "C:\\work\\mobile", status: "running", gatewayHeld: true }),
        expect.objectContaining({ id: "thread-desktop", title: "Desktop task", name: "Desktop task", cwd: "C:\\work\\desktop", status: "idle", gatewayHeld: false })
      ],
      unmappedIds: ["thread-unmapped"]
    });
    expect(upstream.calls.map(call => call.method)).not.toContain("thread/read");
    expect(upstream.calls.map(call => call.method)).not.toContain("thread/turns/list");
    expect(upstream.calls.map(call => call.method)).not.toContain("thread/resume");
    socket.close();
    await once(socket, "close");
  });

  it("summarizes rolling success, latency, timeout, and reconnect metrics", () => {
    let now = 1_000_000;
    const metrics = new RollingGatewayMetrics(() => now);
    metrics.recordUpstream(100, true);
    metrics.recordUpstream(200, false);
    metrics.recordUpstreamTimeout(300);
    metrics.recordSnapshot(400, true);
    metrics.recordSnapshot(500, false);
    metrics.recordReconnect();

    expect(metrics.snapshot()).toEqual({
      windowMs: 300_000,
      upstream: { requests: 3, failures: 2, timeouts: 1, successRate: 1 / 3, p95Ms: 300, p99Ms: 300 },
      snapshots: { runs: 2, failures: 1, successRate: 0.5, p95Ms: 500 },
      reconnects: 1
    });

    now += 300_001;
    expect(metrics.snapshot()).toMatchObject({ upstream: { requests: 0 }, snapshots: { runs: 0 }, reconnects: 0 });
  });

  it("reserves upstream capacity for writes and approvals before background snapshots", () => {
    expect(backgroundSnapshotCapacity(0, 0, 0)).toBe(4);
    expect(backgroundSnapshotCapacity(0, 0, 3)).toBe(1);
    expect(backgroundSnapshotCapacity(0, 0, 4)).toBe(0);
    expect(backgroundSnapshotCapacity(1, 0, 0)).toBe(0);
    expect(backgroundSnapshotCapacity(0, 1, 0)).toBe(0);
  });
});
