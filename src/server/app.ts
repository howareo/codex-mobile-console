import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { AppServerClient, type AppServerFrame, type AppServerRequestPriority } from "../protocol/app-server-client.js";
import type { ApprovalRequest, JsonObject, LoadedTasksDiagnosticsResult, ModelListResult, RpcId, RpcNotification, ThreadMetadataResult, ThreadPageResult, ThreadSummary } from "../shared/types.js";
import type { GatewayConfig } from "./config.js";
import { GatewayLogger, RollingGatewayMetrics, type LogLevel } from "./diagnostics.js";
import { SessionStore } from "./sessions.js";

const COOKIE_NAME = "codex_mobile_session";
const MOBILE_TURN_PAGE_SIZE = 10;
const WRITE_RECEIPT_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_COALESCE_MS = 180;
const MAX_CONCURRENT_SNAPSHOTS = 4;
const SOCKET_HEARTBEAT_MS = 15_000;
const SOCKET_STALE_MS = 45_000;
const MODEL_LIST_CACHE_MS = 5 * 60 * 1000;
const MAX_LOADED_TASK_PAGES = 100;
const MAX_LOADED_TASK_IDS = 10_000;
const MAX_THREAD_LIST_PAGES = 100;
const MAX_MODEL_LIST_PAGES = 100;
const UNSUBSCRIBE_RETRY_ATTEMPTS = 3;
const UNSUBSCRIBE_RETRY_DELAYS_MS = [100, 300] as const;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);

interface WriteReceipt {
  expiresAt: number;
  promise: Promise<unknown>;
}

export async function createGatewayApp(config: GatewayConfig, upstream: AppServerClient, logger = new GatewayLogger(config.logFile)): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    https: config.tls ? { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) } : undefined
  } as any) as unknown as FastifyInstance;
  const sessions = await SessionStore.open({
    ttlMs: config.sessionTtlMs,
    pairingSecret: config.pairingSecret,
    filePath: config.sessionStoreFile,
    onError: (event, error) => logger.error(event, { error })
  });
  const sockets = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, string>();
  const socketPongAt = new Map<WebSocket, number>();
  const socketSessionIds = new Map<WebSocket, string>();
  const approvals = new Map<string, ApprovalRequest>();
  const activeThreadWrites = new Map<string, string>();
  const writeReceipts = new Map<string, WriteReceipt>();
  const subscribedThreads = new Set<string>();
  const unsubscribeFailures = new Map<string, { attempts: number; lastErrorAt: string }>();
  const mobileResumedThreads = subscribedThreads;
  const threadLifecycle = new Map<string, Promise<void>>();
  const releaseInFlight = new Set<string>();
  const threadPageInFlight = new Map<string, Promise<ThreadPageResult>>();
  const pendingSnapshotThreads = new Set<string>();
  const requestStartedAt = new Map<string, number>();
  const metrics = new RollingGatewayMetrics();
  let threadListCache: { expiresAt: number; payload: { data: ThreadSummary[] } } | null = null;
  let threadListInFlight: Promise<{ data: ThreadSummary[] }> | null = null;
  let modelListCache: { expiresAt: number; payload: ModelListResult } | null = null;
  let modelListInFlight: Promise<ModelListResult> | null = null;
  const startedAt = Date.now();
  const runtimeDir = config.logFile ? dirname(config.logFile) : null;
  let snapshotsRunning = false;
  let lastSnapshotAt: string | null = null;
  let lastSnapshotErrorAt: string | null = null;
  let lastSnapshotLogAt = 0;
  let lastSnapshotErrorLogAt = 0;
  let snapshotFlushTimer: ReturnType<typeof setTimeout> | undefined;
  await app.register(cookie);
  await app.register(websocket);

  // Fastify's default 500 response hides the useful upstream message. Keep
  // the status and reason visible to the mobile client, while removing fields
  // that could contain pairing credentials.
  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = errorStatusCode(error) ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
    const message = publicErrorMessage(error);
    logger.error("http.error", { requestId: request.id, method: request.method, route: request.routeOptions.url || request.url.split("?", 1)[0], statusCode, error: message });
    return reply.code(statusCode).send({ error: message, status: statusCode });
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    if (config.tls) reply.header("Strict-Transport-Security", "max-age=31536000");
    requestStartedAt.set(request.id, Date.now());
    logger.info("http.request", { requestId: request.id, method: request.method, route: request.routeOptions.url || request.url.split("?", 1)[0] });
  });
  app.addHook("onResponse", async (request, reply) => {
    const beganAt = requestStartedAt.get(request.id);
    requestStartedAt.delete(request.id);
    logger.info("http.response", { requestId: request.id, method: request.method, route: request.routeOptions.url || request.url.split("?", 1)[0], statusCode: reply.statusCode, durationMs: beganAt ? Date.now() - beganAt : null });
  });
  app.addHook("onError", async (request, reply, error) => {
    logger.error("http.error", { requestId: request.id, method: request.method, route: request.routeOptions.url || request.url.split("?", 1)[0], statusCode: reply.statusCode, error: publicErrorMessage(error) });
  });
  const staticRoot = config.staticRoot;
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      setHeaders: (response, path) => {
        if (path.endsWith(".mobileconfig")) {
          response.header("Content-Type", "application/x-apple-aspen-config");
        }
        if (path.endsWith("index.html") || path.endsWith("sw.js") || path.endsWith("registerSW.js")) {
          response.header("Cache-Control", "no-store");
        }
      }
    });
  }

  const setSessionCookie = (reply: FastifyReply, id: string, expiresAt: number): void => {
    reply.setCookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: "strict",
      secure: Boolean(config.tls),
      path: "/",
      maxAge: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))
    });
  };

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("Cache-Control", "no-store");
    const id = request.cookies[COOKIE_NAME];
    const session = sessions.use(id, request.method !== "DELETE");
    if (!session) {
      logger.warn("auth.rejected", { requestId: request.id, method: request.method, route: request.routeOptions.url || request.url.split("?", 1)[0] });
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (session.renewed && id) setSessionCookie(reply, id, session.expiresAt);
  };

  // 短时间内复用任务列表，并合并多个浏览器同时发起的读取请求。
  const loadThreadList = (): Promise<{ data: ThreadSummary[] }> => {
    if (threadListCache && threadListCache.expiresAt > Date.now()) return Promise.resolve(threadListCache.payload);
    if (threadListInFlight) return threadListInFlight;
    const request = (async () => {
      const threads: ThreadSummary[] = [];
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < MAX_THREAD_LIST_PAGES; pageIndex++) {
        const page = await upstream.listThreads(cursor);
        if (Array.isArray(page.data)) threads.push(...page.data);
        const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : null;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) throw new Error("thread/list 返回重复游标，已停止分页");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (pageIndex === MAX_THREAD_LIST_PAGES - 1) throw new Error("thread/list 超过最大分页页数，已停止读取");
      }
      const payload = { data: threads };
      threadListCache = { expiresAt: Date.now() + 1_000, payload };
      return payload;
    })();
    threadListInFlight = request;
    const clearInFlight = () => {
      if (threadListInFlight === request) threadListInFlight = null;
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  };

  // 模型目录变化远低于任务状态，短时缓存避免每个手机页面重复挤压共享 app-server。
  const loadModelList = (): Promise<ModelListResult> => {
    if (modelListCache && modelListCache.expiresAt > Date.now()) return Promise.resolve(modelListCache.payload);
    if (modelListInFlight) return modelListInFlight;
    const request = (async () => {
      const models = [];
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < MAX_MODEL_LIST_PAGES; pageIndex++) {
        const page = await upstream.listModels(cursor, false);
        if (Array.isArray(page.data)) models.push(...page.data);
        const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : null;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) throw new Error("model/list 返回重复游标，已停止分页");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (pageIndex === MAX_MODEL_LIST_PAGES - 1) throw new Error("model/list 超过最大分页页数，已停止读取");
      }
      const payload: ModelListResult = { data: models, nextCursor: null };
      modelListCache = { expiresAt: Date.now() + MODEL_LIST_CACHE_MS, payload };
      return payload;
    })();
    modelListInFlight = request;
    const clearInFlight = () => {
      if (modelListInFlight === request) modelListInFlight = null;
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  };

  const loadLoadedThreadIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_LOADED_TASK_PAGES && ids.length < MAX_LOADED_TASK_IDS; pageIndex++) {
      const page = await upstream.listLoadedThreads(cursor);
      for (const id of page.data) {
        if (ids.length >= MAX_LOADED_TASK_IDS) break;
        if (typeof id === "string" && id) ids.push(id);
      }
      const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : null;
      if (!nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(nextCursor)) throw new Error("thread/loaded/list 返回重复游标，已停止分页");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (cursor && ids.length < MAX_LOADED_TASK_IDS) throw new Error("thread/loaded/list 超过最大分页页数，已停止读取");
    if (cursor) logger.warn("thread.loaded_list_truncated", { maxTaskIds: MAX_LOADED_TASK_IDS });
    return [...new Set(ids)];
  };

  // 同一任务的首页快照只保留一个在途 RPC，历史分页仍按各自游标独立读取。
  const loadThreadPage = (threadId: string, cursor?: string, priority: AppServerRequestPriority = "foreground"): Promise<ThreadPageResult> => {
    if (cursor) return mobileThreadPage(upstream, threadId, cursor, priority);
    // Detail snapshots are turns-only; session settings come from the existing
    // thread/list summary and are merged by the mobile client.
    const inFlightKey = `${priority}:${threadId}`;
    const existing = threadPageInFlight.get(inFlightKey);
    if (existing) return existing;
    const request = mobileThreadPage(upstream, threadId, undefined, priority);
    threadPageInFlight.set(inFlightKey, request);
    const clearInFlight = () => {
      if (threadPageInFlight.get(inFlightKey) === request) threadPageInFlight.delete(inFlightKey);
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  };

  const runThreadLifecycle = async <T>(threadId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = threadLifecycle.get(threadId) ?? Promise.resolve();
    let finish: () => void = () => undefined;
    const current = new Promise<void>(resolve => {
      finish = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    threadLifecycle.set(threadId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      finish();
      if (threadLifecycle.get(threadId) === tail) threadLifecycle.delete(threadId);
    }
  };

  // thread/resume subscribes this gateway connection to the task. Keep that
  // subscription only while the phone is viewing a task or it is still busy;
  // app-server then unloads an idle, unobserved task after its own delay.
  const releaseThreadIfUnused = (threadId: string): void => {
    if (!subscribedThreads.has(threadId) || releaseInFlight.has(threadId)) return;
    if (hasMobileSubscription(threadId, subscriptions) || activeThreadWrites.has(threadId) || hasPendingApproval(threadId, approvals)) return;
    releaseInFlight.add(threadId);
    void runThreadLifecycle(threadId, async () => {
      if (!subscribedThreads.has(threadId)) return;
      if (hasMobileSubscription(threadId, subscriptions) || activeThreadWrites.has(threadId) || hasPendingApproval(threadId, approvals)) return;
      const metadata = await upstream.readThreadMetadata(threadId, "background");
      if (hasMobileSubscription(threadId, subscriptions) || activeThreadWrites.has(threadId) || hasPendingApproval(threadId, approvals)) return;
      if (!isIdleThreadStatus(metadata.thread.status)) {
        logger.info("thread.unsubscribe_deferred", { threadId, status: threadStatusValue(metadata.thread.status) });
        return;
      }
      try {
        const result = await unsubscribeWithRetry(upstream, threadId, logger, () => !hasMobileSubscription(threadId, subscriptions) && !activeThreadWrites.has(threadId) && !hasPendingApproval(threadId, approvals));
        unsubscribeFailures.delete(threadId);
        logger.info("thread.unsubscribed", { threadId, status: result.status });
      } finally {
        // A failed or timed-out unsubscribe has an unknown upstream state.
        // Force the next write to resume rather than trusting stale local data.
        subscribedThreads.delete(threadId);
      }
    }).catch(error => {
      unsubscribeFailures.set(threadId, { attempts: UNSUBSCRIBE_RETRY_ATTEMPTS, lastErrorAt: new Date().toISOString() });
      logger.warn("thread.unsubscribe_failed", { threadId, error });
    }).finally(() => {
      releaseInFlight.delete(threadId);
    });
  };

  const ensureThreadSubscription = async (threadId: string): Promise<void> => {
    await runThreadLifecycle(threadId, async () => {
      if (subscribedThreads.has(threadId)) return;
      await upstream.resumeThread(threadId);
      subscribedThreads.add(threadId);
      logger.info("thread.resumed", { threadId });
    });
  };

  const flushSnapshotQueue = (): void => {
    if (snapshotsRunning || pendingSnapshotThreads.size === 0) return;
    const capacity = backgroundSnapshotCapacity(activeThreadWrites.size, approvals.size, upstream.pendingRequestCount ?? 0);
    if (capacity === 0) {
      scheduleSnapshotFlush(SNAPSHOT_COALESCE_MS);
      return;
    }
    const threadIds = [...pendingSnapshotThreads]
      .filter(threadId => hasMobileSubscription(threadId, subscriptions))
      .slice(0, capacity);
    for (const threadId of threadIds) pendingSnapshotThreads.delete(threadId);
    if (threadIds.length === 0) return;
    snapshotsRunning = true;
    const snapshotStartedAt = Date.now();
    void Promise.allSettled(threadIds.map(async threadId => {
      const result = await loadThreadPage(threadId, undefined, "background");
      const frame = JSON.stringify({ method: "thread/snapshot", params: result });
      for (const [socket, subscribedThreadId] of subscriptions) {
        if (subscribedThreadId === threadId && socket.readyState === 1) socket.send(frame);
      }
    })).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const successCount = results.length - failures.length;
      const durationMs = Date.now() - snapshotStartedAt;
      metrics.recordSnapshot(durationMs, failures.length === 0);
      if (successCount > 0) lastSnapshotAt = new Date().toISOString();
      if (failures.length > 0) {
        lastSnapshotErrorAt = new Date().toISOString();
        if (Date.now() - lastSnapshotErrorLogAt >= 5_000) {
          lastSnapshotErrorLogAt = Date.now();
          logger.error("snapshot.partial_failed", { threadCount: threadIds.length, successCount, failedCount: failures.length, subscriptions: subscriptions.size, durationMs, error: failures[0]?.reason });
        }
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            const threadId = threadIds[index];
            for (const [socket, subscribedThreadId] of subscriptions) {
              if (subscribedThreadId === threadId && socket.readyState === 1) socket.send(JSON.stringify({ method: "thread/snapshotError", params: { threadId } }));
            }
          }
        }
      } else if (Date.now() - lastSnapshotLogAt >= 30_000) {
        lastSnapshotLogAt = Date.now();
        logger.info("snapshot.ok", { threadCount: threadIds.length, subscriptions: subscriptions.size, durationMs });
      }
    }).finally(() => {
      snapshotsRunning = false;
      if (pendingSnapshotThreads.size > 0) scheduleSnapshotFlush(0);
    });
  };

  const scheduleSnapshotFlush = (delayMs = SNAPSHOT_COALESCE_MS): void => {
    if (snapshotFlushTimer !== undefined) return;
    snapshotFlushTimer = setTimeout(() => {
      snapshotFlushTimer = undefined;
      flushSnapshotQueue();
    }, delayMs);
  };

  const readConfigReloadStatus = async (): Promise<{
    state: "pending" | "applied" | "unknown";
    pendingFingerprint: string | null;
    appliedFingerprint: string | null;
    requestedAt: string | null;
  }> => {
    if (!runtimeDir) return { state: "unknown", pendingFingerprint: null, appliedFingerprint: null, requestedAt: null };
    const readJson = async (name: string): Promise<JsonObject | null> => {
      try {
        const value = JSON.parse(await readFile(join(runtimeDir, name), "utf8"));
        return objectValue(value);
      } catch {
        return null;
      }
    };
    const pendingPath = join(runtimeDir, "pending-app-server-reload.json");
    const pendingExists = existsSync(pendingPath);
    const pending = await readJson("pending-app-server-reload.json");
    const applied = await readJson("app-server-config-fingerprint.json");
    const pendingFingerprint = typeof pending?.fingerprint === "string" ? pending.fingerprint : null;
    const appliedFingerprint = typeof applied?.fingerprint === "string" ? applied.fingerprint : null;
    return {
      state: pendingExists ? (pending ? (pendingFingerprint && pendingFingerprint === appliedFingerprint ? "applied" : "pending") : "unknown") : applied ? "applied" : "unknown",
      pendingFingerprint,
      appliedFingerprint,
      requestedAt: typeof pending?.requestedAt === "string" ? pending.requestedAt : null
    };
  };

  const queueSnapshot = (threadId: string): void => {
    if (!hasMobileSubscription(threadId, subscriptions)) return;
    pendingSnapshotThreads.add(threadId);
    scheduleSnapshotFlush();
  };

  app.get("/api/client-reset", async (_request, reply) => {
    reply.header("Cache-Control", "no-store").type("text/html");
    return `<!doctype html><meta charset="utf-8"><title>Updating</title><body style="background:#101210;color:#e8ece9;font-family:system-ui;padding:24px">Updating mobile console...<script>(async()=>{if("serviceWorker"in navigator){for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister()}if("caches"in window){for(const key of await caches.keys())await caches.delete(key)}location.replace("/?v=2026080902")})()</script></body>`;
  });

  app.get("/api/health", { preHandler: requireSession }, async () => ({
    ok: true,
    phase: "read-write",
    appServer: upstream.initializeResult,
    diagnostics: { enabled: true }
  }));

  app.get("/api/models", { preHandler: requireSession }, async () => loadModelList());

  app.get("/api/diagnostics/status", { preHandler: requireSession }, async () => ({
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    upstream: {
      state: upstream.connectionState || "unknown",
      pendingRequests: upstream.pendingRequestCount ?? 0,
      reconnectScheduled: upstream.reconnectScheduled ?? false,
      reconnectRetryAfterMs: upstream.reconnectRetryAfterMs ?? null
    },
    realtime: {
      sockets: sockets.size,
      subscriptions: subscriptions.size,
      snapshotsRunning,
      threadPagesInFlight: threadPageInFlight.size,
      lastSnapshotAt,
      lastSnapshotErrorAt,
      backgroundPaused: backgroundSnapshotCapacity(activeThreadWrites.size, approvals.size, upstream.pendingRequestCount ?? 0) === 0,
      backgroundPauseReason: backgroundSnapshotPauseReason(activeThreadWrites.size, approvals.size, upstream.pendingRequestCount ?? 0),
      mode: "adaptive"
    },
    writes: { activeThreads: activeThreadWrites.size },
    stability: metrics.snapshot(),
    approvals: approvals.size,
    unsubscribeFailures: [...unsubscribeFailures.entries()].map(([threadId, value]) => ({ threadId, ...value })),
    config: await readConfigReloadStatus(),
    log: { enabled: Boolean(config.logFile), fileName: logger.fileName }
  }));

  app.get("/api/diagnostics/loaded-tasks", { preHandler: requireSession }, async (): Promise<LoadedTasksDiagnosticsResult> => {
    const loadedIds = await loadLoadedThreadIds();
    const summaries = (await loadThreadList()).data;
    const summariesById = new Map(summaries.map(summary => [summary.id, summary]));
    const data: LoadedTasksDiagnosticsResult["data"] = [];
    const unmappedIds: string[] = [];
    for (const id of loadedIds) {
      const summary = summariesById.get(id);
      if (!summary) {
        unmappedIds.push(id);
        continue;
      }
      data.push({
        id,
        title: typeof summary.title === "string" ? summary.title : null,
        name: typeof summary.name === "string" ? summary.name : null,
        cwd: typeof summary.cwd === "string" ? summary.cwd : null,
        status: summary.status ?? null,
        gatewayHeld: mobileResumedThreads.has(id) || hasMobileSubscription(id, subscriptions)
      });
    }
    return { total: loadedIds.length, data, unmappedIds };
  });

  app.post<{ Body: { level?: string; event?: string; details?: unknown } }>("/api/diagnostics/client", { preHandler: requireSession }, async (request, reply) => {
    const event = typeof request.body?.event === "string" ? request.body.event.trim() : "";
    if (!/^[a-z0-9._-]{1,80}$/i.test(event)) return reply.code(400).send({ error: "invalid diagnostic event" });
    const level: LogLevel = request.body?.level === "error" ? "error" : request.body?.level === "warn" ? "warn" : "info";
    logger[level](`client.${event}`, { requestId: request.id, details: objectValue(request.body?.details) ?? {} });
    return reply.code(204).send();
  });

  app.post<{ Body: { token?: string } }>("/api/auth/session", async (request, reply) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    if (!sessions.authenticate(token, config.pairingSecret)) {
      logger.warn("auth.login_failed", { requestId: request.id });
      return reply.code(401).send({ error: "invalid pairing token" });
    }
    const session = sessions.create();
    await sessions.flush();
    reply.header("Cache-Control", "no-store");
    setSessionCookie(reply, session.id, session.expiresAt);
    logger.info("auth.login_succeeded", { requestId: request.id });
    return { ok: true, epoch: session.epoch, expiresAt: session.expiresAt };
  });

  app.get("/api/auth/session", { preHandler: requireSession }, async request => {
    const session = sessions.use(request.cookies[COOKIE_NAME], false);
    return session ? { ok: true, epoch: session.epoch, expiresAt: session.expiresAt } : { ok: false };
  });

  app.delete("/api/auth/session", { preHandler: requireSession }, async (request, reply) => {
    sessions.revoke(request.cookies[COOKIE_NAME]);
    await sessions.flush();
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    logger.info("auth.logout", { requestId: request.id });
    return { ok: true };
  });

  app.get("/api/threads", { preHandler: requireSession }, async () => loadThreadList());

  // Detail history stays turns-only. Session parameters are fetched only when
  // the mobile user explicitly opens the composer settings for this task.
  app.get<{ Params: { threadId: string } }>("/api/threads/:threadId/metadata", { preHandler: requireSession }, async (request): Promise<ThreadMetadataResult> => {
    const metadata = await upstream.readThreadMetadata(request.params.threadId, "foreground");
    return {
      id: request.params.threadId,
      model: metadata.model ?? metadata.thread.model ?? null,
      modelProvider: metadata.modelProvider ?? metadata.thread.modelProvider ?? null,
      reasoningEffort: metadata.reasoningEffort ?? metadata.thread.reasoningEffort ?? null
    };
  });

  app.get<{ Params: { threadId: string }; Querystring: { cursor?: string } }>("/api/threads/:threadId", { preHandler: requireSession }, async request => {
    return loadThreadPage(request.params.threadId, request.query.cursor);
  });

  app.post<{ Params: { threadId: string }; Body: { text?: string; activeTurnId?: string; requestId?: string; model?: string | null; reasoningEffort?: string | null } }>("/api/threads/:threadId/turns", { preHandler: requireSession }, async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "message text is required" });
    const requestId = mobileRequestId(request.body?.requestId);
    if (!requestId) return reply.code(400).send({ error: "invalid request id" });
    const receiptKey = `${request.params.threadId}:${requestId}`;
    pruneWriteReceipts(writeReceipts);
    const existing = writeReceipts.get(receiptKey);
    if (existing) {
      logger.info("write.deduplicated", { requestId, threadId: request.params.threadId });
      return existing.promise;
    }
    const activeRequestId = activeThreadWrites.get(request.params.threadId);
    if (activeRequestId) return reply.code(409).send({ error: "task action already in progress", requestId, activeRequestId });
    const activeTurnId = typeof request.body?.activeTurnId === "string" ? request.body.activeTurnId : null;
    const hasModel = Object.prototype.hasOwnProperty.call(request.body ?? {}, "model");
    const selectedModel = request.body?.model === null ? null : typeof request.body?.model === "string" ? request.body.model.trim() : undefined;
    const hasReasoningEffort = Object.prototype.hasOwnProperty.call(request.body ?? {}, "reasoningEffort");
    const selectedReasoningEffort = request.body?.reasoningEffort === null ? null : typeof request.body?.reasoningEffort === "string" ? request.body.reasoningEffort.trim() : undefined;
    if (hasModel && selectedModel === undefined) return reply.code(400).send({ error: "invalid model" });
    if (hasReasoningEffort && selectedReasoningEffort === undefined) return reply.code(400).send({ error: "invalid reasoning effort" });
    if (activeTurnId && (hasModel || hasReasoningEffort)) return reply.code(409).send({ error: "model and reasoning effort cannot change while task is running" });
    const acceptedAt = new Date().toISOString();
    activeThreadWrites.set(request.params.threadId, requestId);
    const action = (async () => {
      if (activeTurnId) {
        await ensureThreadSubscription(request.params.threadId);
        const result = await upstream.steerTurn(request.params.threadId, activeTurnId, text);
        threadListCache = null;
        return { requestId, acceptedAt, mode: "steer", ...result };
      }
      // thread/read supplies persisted settings without instantiating the
      // task. Resume once per gateway connection to subscribe mobile realtime
      // updates; repeated sends on the same task reuse that subscription.
      const sessionSettings = await upstream.readThreadMetadata(request.params.threadId);
      let selectedModelInfo: ModelListResult["data"][number] | undefined;
      if (hasModel || hasReasoningEffort) {
        const models = await loadModelList();
        const sessionModel = typeof sessionSettings.model === "string" && sessionSettings.model
          ? models.data.find(candidate => candidate.id === sessionSettings.model || candidate.model === sessionSettings.model)
          : undefined;
        selectedModelInfo = hasModel && selectedModel !== null
          ? models.data.find(candidate => candidate.id === selectedModel || candidate.model === selectedModel)
          : sessionModel;
        if (hasModel && selectedModel !== null && !selectedModelInfo) {
          const error = new Error("model is not available") as Error & { statusCode?: number };
          error.statusCode = 400;
          throw error;
        }
        if (hasReasoningEffort && selectedReasoningEffort !== null && !selectedModelInfo?.supportedReasoningEfforts.some(option => option.reasoningEffort === selectedReasoningEffort)) {
          const error = new Error("reasoning effort is not available for this model") as Error & { statusCode?: number };
          error.statusCode = 400;
          throw error;
        }
      }
      await ensureThreadSubscription(request.params.threadId);
      const startSettings = {
        ...(hasModel ? { model: selectedModel ?? null } : {}),
        ...(hasReasoningEffort ? { effort: selectedReasoningEffort ?? null } : {})
      };
      let recovered = false;
      let result;
      try {
        result = await upstream.startTurn(request.params.threadId, text, startSettings);
      } catch (error) {
        if (!isThreadNotFoundError(error)) throw error;
        recovered = true;
        logger.warn("write.resume_after_thread_not_found", { requestId, threadId: request.params.threadId });
        subscribedThreads.delete(request.params.threadId);
        await ensureThreadSubscription(request.params.threadId);
        result = await upstream.startTurn(request.params.threadId, text, startSettings);
      }
      threadListCache = null;
      return {
        requestId,
        acceptedAt,
        mode: "start",
        recovered,
        model: hasModel ? selectedModel : sessionSettings.model ?? null,
        reasoningEffort: hasReasoningEffort ? selectedReasoningEffort : sessionSettings.reasoningEffort ?? null,
        ...result
      };
    })();
    writeReceipts.set(receiptKey, { expiresAt: Date.now() + WRITE_RECEIPT_TTL_MS, promise: action });
    logger.info("write.accepted", { requestId, threadId: request.params.threadId, mode: activeTurnId ? "steer" : "start" });
    try {
      return await action;
    } catch (error) {
      writeReceipts.delete(receiptKey);
      const statusCode = errorStatusCode(error) ?? 500;
      if (statusCode !== 500) return reply.code(statusCode).send({ error: publicErrorMessage(error), status: statusCode });
      throw error;
    } finally {
      if (activeThreadWrites.get(request.params.threadId) === requestId) {
        activeThreadWrites.delete(request.params.threadId);
        releaseThreadIfUnused(request.params.threadId);
      }
    }
  });

  app.post<{ Params: { threadId: string; turnId: string } }>("/api/threads/:threadId/turns/:turnId/interrupt", { preHandler: requireSession }, async (request, reply) => {
    if (activeThreadWrites.has(request.params.threadId)) return reply.code(409).send({ error: "task action already in progress" });
    const requestId = `interrupt-${randomUUID()}`;
    activeThreadWrites.set(request.params.threadId, requestId);
    try {
      await upstream.interruptTurn(request.params.threadId, request.params.turnId);
      threadListCache = null;
      return { ok: true };
    } finally {
      if (activeThreadWrites.get(request.params.threadId) === requestId) {
        activeThreadWrites.delete(request.params.threadId);
        releaseThreadIfUnused(request.params.threadId);
      }
    }
  });

  app.get("/api/approvals", { preHandler: requireSession }, async () => ({ data: [...approvals.values()] }));

  app.post<{ Params: { requestId: string }; Body: { decision?: string } }>("/api/approvals/:requestId", { preHandler: requireSession }, async (request, reply) => {
    const approval = approvals.get(request.params.requestId);
    if (!approval) return reply.code(404).send({ error: "approval request not found" });
    if (request.body?.decision !== "accept" && request.body?.decision !== "decline") {
      return reply.code(400).send({ error: "decision must be accept or decline" });
    }
    upstream.respondToServerRequest(approval.id, approvalResponse(approval, request.body.decision));
    approvals.delete(request.params.requestId);
    const threadId = typeof approval.params.threadId === "string" ? approval.params.threadId : null;
    if (threadId) releaseThreadIfUnused(threadId);
    logger.info("approval.resolved", { approvalId: approval.id, method: approval.method, decision: request.body.decision });
    broadcast(sockets, { method: "approval/resolved", params: { requestId: approval.id } }, logger);
    return { ok: true };
  });

  app.get("/api/events", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const sessionId = request.cookies[COOKIE_NAME];
    if (!sessions.use(sessionId, false) || !sessionId) {
      logger.warn("ws.auth_rejected", { requestId: request.id });
      socket.close(1008, "unauthorized");
      return;
    }
    sockets.add(socket);
    socketPongAt.set(socket, Date.now());
    socketSessionIds.set(socket, sessionId);
    logger.info("ws.open", { requestId: request.id, sockets: sockets.size });
    socket.on("pong", () => socketPongAt.set(socket, Date.now()));
    socket.on("message", raw => {
      let message: JsonObject | null;
      try {
        message = objectValue(JSON.parse(raw.toString()));
      } catch (error) {
        logger.warn("ws.invalid_message", { requestId: request.id, error });
        return;
      }
      const params = objectValue(message?.params);
      if (message?.method === "thread/unsubscribe") {
        const threadId = subscriptions.get(socket);
        if (threadId) {
          subscriptions.delete(socket);
          removeUnusedSnapshotPending(threadId, subscriptions, pendingSnapshotThreads);
          releaseThreadIfUnused(threadId);
          logger.info("ws.unsubscribed", { requestId: request.id, threadId, subscriptions: subscriptions.size });
        }
        if (socket.readyState === 1) socket.send(JSON.stringify({ method: "thread/unsubscribed", params: { threadId: threadId ?? null } }));
        return;
      }
      if (message?.method !== "thread/subscribe" || typeof params?.threadId !== "string") {
        logger.warn("ws.invalid_subscription", { requestId: request.id, method: message?.method });
        return;
      }
      const threadId = params.threadId;
      const previousThreadId = subscriptions.get(socket);
      if (previousThreadId === threadId) {
        logger.info("ws.subscribe_duplicate", { requestId: request.id, threadId, subscriptions: subscriptions.size });
        return;
      }
      subscriptions.set(socket, threadId);
      if (previousThreadId && previousThreadId !== threadId) {
        removeUnusedSnapshotPending(previousThreadId, subscriptions, pendingSnapshotThreads);
        releaseThreadIfUnused(previousThreadId);
      }
      logger.info("ws.subscribed", { requestId: request.id, threadId, subscriptions: subscriptions.size });
    });
    socket.on("error", error => logger.error("ws.error", { requestId: request.id, error }));
    socket.on("close", (code, reason) => {
      const threadId = subscriptions.get(socket);
      sockets.delete(socket);
      subscriptions.delete(socket);
      socketPongAt.delete(socket);
      socketSessionIds.delete(socket);
      if (threadId) {
        removeUnusedSnapshotPending(threadId, subscriptions, pendingSnapshotThreads);
        releaseThreadIfUnused(threadId);
      }
      logger.info("ws.close", { requestId: request.id, code, reason: reason.toString(), sockets: sockets.size, subscriptions: subscriptions.size });
    });
    socket.send(JSON.stringify({ method: "connection/ready", params: { phase: "read-write", upstreamState: upstream.connectionState } }));
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      if (!sessions.use(socketSessionIds.get(socket), false)) {
        logger.warn("ws.session_expired", { sockets: sockets.size });
        socket.close(1008, "session expired");
        continue;
      }
      const lastPong = socketPongAt.get(socket) ?? now;
      if (now - lastPong > SOCKET_STALE_MS) {
        logger.warn("ws.stale_terminated", { staleMs: now - lastPong, sockets: sockets.size });
        socket.terminate();
        continue;
      }
      try {
        socket.ping();
        socket.send(JSON.stringify({ method: "connection/heartbeat", params: { upstreamState: upstream.connectionState, timestamp: new Date(now).toISOString() } }));
      } catch (error) {
        logger.warn("ws.heartbeat_failed", { error });
      }
    }
  }, SOCKET_HEARTBEAT_MS);

  const metricsLogTimer = setInterval(() => {
    logger.info("stability.window", { ...metrics.snapshot() });
  }, 60_000);

  app.addHook("onClose", async () => {
    clearInterval(heartbeatTimer);
    clearInterval(metricsLogTimer);
    if (snapshotFlushTimer !== undefined) clearTimeout(snapshotFlushTimer);
    pendingSnapshotThreads.clear();
    await sessions.flush();
    logger.info("gateway.stopped", { uptimeMs: Date.now() - startedAt });
    await logger.flush();
  });

  upstream.on("notification", (message: unknown) => {
    const notification = notificationValue(message);
    if (notification && (notification.method.startsWith("thread/") || notification.method.startsWith("turn/"))) threadListCache = null;
    const targetThreadId = notification ? notificationThreadId(notification) : null;
    if (targetThreadId && hasMobileSubscription(targetThreadId, subscriptions) && (notification?.method.startsWith("thread/") || notification?.method.startsWith("turn/") || notification?.method.startsWith("item/"))) {
      queueSnapshot(targetThreadId);
    }
    if (targetThreadId && notification?.method === "thread/status/changed" && isIdleThreadStatus(notificationStatus(notification))) {
      releaseThreadIfUnused(targetThreadId);
    }
    if (notification && /(?:started|completed|error|resolved|status)/i.test(notification.method)) {
      logger.info("upstream.notification", { method: notification.method });
    }
    if (notification?.method === "serverRequest/resolved") {
      const params = objectValue(notification.params);
      if (params && isRpcId(params.requestId)) {
        const approval = approvals.get(String(params.requestId));
        approvals.delete(String(params.requestId));
        const threadId = approval && typeof approval.params.threadId === "string" ? approval.params.threadId : null;
        if (threadId) releaseThreadIfUnused(threadId);
      }
    }
    const outbound = compactNotification(message);
    const globalNotification = notification?.method.startsWith("connection/") || notification?.method === "serverRequest/resolved" || notification?.method === "approval/resolved";
    if (notification && targetThreadId && !globalNotification) {
      broadcastToThread(sockets, subscriptions, targetThreadId, outbound, logger);
    } else {
      broadcast(sockets, outbound, logger);
    }
  });
  upstream.on("serverRequest", (message: unknown) => {
    const approval = approvalValue(message);
    if (approval && APPROVAL_METHODS.has(approval.method)) approvals.set(String(approval.id), approval);
    logger.info("upstream.server_request", { method: approval?.method || "unknown", approvalId: approval?.id, approvals: approvals.size });
    broadcast(sockets, { method: "connection/serverRequest", params: { message: compactNotification(message) } }, logger);
  });
  upstream.on("frame", (frame: AppServerFrame) => {
    const routineSnapshot = frame.method === "thread/turns/list" && frame.ok !== false && (frame.durationMs ?? 0) < 2000;
    if (frame.direction === "request" && frame.method !== "thread/turns/list") logger.info("upstream.request", { method: frame.method, pendingRequests: upstream.pendingRequestCount });
    if (frame.direction === "response" && typeof frame.durationMs === "number") metrics.recordUpstream(frame.durationMs, frame.ok !== false);
    if (frame.direction === "response" && !routineSnapshot) logger[frame.ok === false ? "warn" : "info"]("upstream.response", { method: frame.method, ok: frame.ok, durationMs: frame.durationMs, pendingRequests: upstream.pendingRequestCount });
  });
  upstream.on("requestTimeout", (value: unknown) => {
    const details = objectValue(value) ?? {};
    if (typeof details.durationMs === "number") metrics.recordUpstreamTimeout(details.durationMs);
    logger.error("upstream.timeout", { ...details });
  });
  upstream.on("error", (error: Error) => logger.error("upstream.error", { error }));
  upstream.on("close", (error: Error) => {
    approvals.clear();
    subscribedThreads.clear();
    threadLifecycle.clear();
    releaseInFlight.clear();
    logger.error("upstream.closed", { error });
    broadcast(sockets, { method: "connection/upstream", params: { state: "reconnecting" } }, logger);
  });
  upstream.on("connected", (value: unknown) => {
    const details = objectValue(value) ?? {};
    if (details.reconnected === true) metrics.recordReconnect();
    logger.info("upstream.connected", { ...details });
    broadcast(sockets, { method: "connection/upstream", params: { state: "open" } }, logger);
  });

  if (existsSync(staticRoot)) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

function approvalResponse(approval: ApprovalRequest, decision: "accept" | "decline"): unknown {
  if (approval.method === "item/commandExecution/requestApproval" || approval.method === "item/fileChange/requestApproval") {
    return { decision: decision === "accept" ? "accept" : "decline" };
  }
  if (approval.method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "accept" ? objectValue(approval.params.permissions) ?? {} : {},
      scope: "turn"
    };
  }
  if (approval.method === "execCommandApproval" || approval.method === "applyPatchApproval") {
    return { decision: decision === "accept" ? "approved" : { denied: { rejection: "Declined from Codex Mobile Console" } } };
  }
  throw new Error(`unsupported approval method: ${approval.method}`);
}

function approvalValue(value: unknown): ApprovalRequest | null {
  const object = objectValue(value);
  if (!object || !isRpcId(object.id) || typeof object.method !== "string") return null;
  return { id: object.id, method: object.method, params: objectValue(object.params) ?? {} };
}

function notificationValue(value: unknown): RpcNotification | null {
  const object = objectValue(value);
  return object && typeof object.method === "string" ? object as unknown as RpcNotification : null;
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function errorStatusCode(error: unknown): number | null {
  const object = objectValue(error);
  const direct = object?.statusCode;
  if (typeof direct === "number" && direct >= 400 && direct <= 599) return direct;
  const message = error instanceof Error ? error.message : typeof object?.message === "string" ? object.message : String(error);
  const match = message.match(/\bstatus(?:\s+code)?\s*[:=]?\s*(4\d{2}|5\d{2})\b/i);
  return match ? Number(match[1]) : null;
}

function isThreadNotFoundError(error: unknown): boolean {
  const object = objectValue(error);
  const message = error instanceof Error ? error.message : typeof object?.message === "string" ? object.message : "";
  // App-server prefixes JSON-RPC failures with the numeric code. Restrict this
  // recovery path to an explicit missing-thread response; transport, timeout,
  // quota, and upstream 5xx failures must retain their original result.
  return /\bthread(?:\s+[\w.-]+)?\s+(?:was\s+)?not\s+found\b/i.test(message);
}

function publicErrorMessage(error: unknown): string {
  const object = objectValue(error);
  const raw = error instanceof Error ? error.message : typeof object?.message === "string" ? object.message : String(error);
  const message = raw
    .replace(/(pairing(?:[-_ ]?(?:secret|token))?|token|secret|authorization|api[-_]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[redacted]")
    .trim();
  return message.length > 4_000 ? `${message.slice(0, 4_000)}\n…（错误信息已截断）` : message || "gateway request failed";
}

function mobileRequestId(value: unknown): string | null {
  if (value == null) return `legacy-${randomUUID()}`;
  if (typeof value !== "string") return null;
  const requestId = value.trim();
  return /^[a-z0-9._-]{8,100}$/i.test(requestId) ? requestId : null;
}

function pruneWriteReceipts(receipts: Map<string, WriteReceipt>): void {
  const now = Date.now();
  for (const [key, receipt] of receipts) {
    if (receipt.expiresAt <= now) receipts.delete(key);
  }
}

function notificationThreadId(notification: RpcNotification): string | null {
  const params = objectValue(notification.params);
  if (typeof params?.threadId === "string") return params.threadId;
  const messageParams = objectValue(objectValue(params?.message)?.params);
  return typeof messageParams?.threadId === "string" ? messageParams.threadId : null;
}

function removeUnusedSnapshotPending(threadId: string, subscriptions: Map<WebSocket, string>, pending: Set<string>): void {
  if (![...subscriptions.values()].includes(threadId)) pending.delete(threadId);
}

function hasMobileSubscription(threadId: string, subscriptions: Map<WebSocket, string>): boolean {
  return [...subscriptions.values()].includes(threadId);
}

function hasPendingApproval(threadId: string, approvals: Map<string, ApprovalRequest>): boolean {
  return [...approvals.values()].some(approval => approval.params.threadId === threadId);
}

function notificationStatus(notification: RpcNotification): unknown {
  const params = objectValue(notification.params);
  if (!params) return undefined;
  if (params.status !== undefined) return params.status;
  return objectValue(params.thread)?.status;
}

function isIdleThreadStatus(value: unknown): boolean {
  return threadStatusValue(value) === "idle";
}

function threadStatusValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  if (!object) return null;
  if (typeof object.type === "string") return object.type;
  return typeof object.status === "string" ? object.status : null;
}

export function backgroundSnapshotCapacity(activeWrites: number, approvals: number, pendingRequests: number): number {
  if (activeWrites > 0 || approvals > 0) return 0;
  return Math.max(0, MAX_CONCURRENT_SNAPSHOTS - Math.max(0, pendingRequests));
}

function backgroundSnapshotPauseReason(activeWrites: number, approvals: number, pendingRequests: number): "write" | "approval" | "upstream_busy" | null {
  if (activeWrites > 0) return "write";
  if (approvals > 0) return "approval";
  return pendingRequests >= MAX_CONCURRENT_SNAPSHOTS ? "upstream_busy" : null;
}

async function mobileThreadPage(upstream: AppServerClient, threadId: string, cursor?: string, priority: AppServerRequestPriority = "foreground"): Promise<ThreadPageResult> {
  // Viewing a task must stay read-only. Resume only immediately before a
  // user-started turn, so opening or refreshing an archived task cannot
  // trigger app-server lifecycle changes.
  const page = await upstream.listThreadTurns(threadId, cursor || null, MOBILE_TURN_PAGE_SIZE, priority);
  const olderCursor = page.nextCursor ?? null;
  return {
    thread: {
      id: threadId,
      turns: [...page.data].reverse().map(mobileTurn)
    },
    history: {
      kind: cursor ? "older" : "head",
      olderCursor,
      hasOlder: olderCursor !== null
    }
  };
}

function mobileTurn(value: unknown): unknown {
  const turn = objectValue(value);
  if (!turn) return value;
  return {
    ...turn,
    items: Array.isArray(turn.items) ? turn.items.map(mobileItem) : []
  };
}

function mobileItem(value: unknown): unknown {
  const item = objectValue(value);
  if (!item) return value;
  const type = typeof item.type === "string" ? item.type : "unknown";
  const projected: JsonObject = {};
  copyMobileFields(projected, item, ["id", "type", "status", "state", "createdAt", "updatedAt"]);
  if (type === "userMessage" || type === "agentMessage") {
    copyMobileFields(projected, item, ["text", "content", "summary"]);
    return projected;
  }
  if (type === "fileChange") {
    projected.changes = (Array.isArray(item.changes) ? item.changes : []).map(change => {
      const source = objectValue(change) ?? {};
      const diff = typeof source.diff === "string" ? source.diff : "";
      const lines = diff ? diff.split(/\r?\n/) : [];
      return {
        path: compactMobileValue(source.path),
        kind: compactMobileValue(source.kind),
        added: lines.filter(line => line.startsWith("+") && !line.startsWith("+++ ")).length,
        removed: lines.filter(line => line.startsWith("-") && !line.startsWith("--- ")).length
      };
    });
    return projected;
  }
  if (type === "commandExecution") {
    copyMobileFields(projected, item, ["command", "commandActions", "cwd", "exitCode"]);
    projected.output = outputPreview(item.aggregatedOutput ?? item.output ?? item.result);
    return projected;
  }
  copyMobileFields(projected, item, ["text", "content", "summary", "server", "tool", "namespace", "error", "durationMs", "query", "path", "savedPath"]);
  const preview = outputPreview(item.result ?? item.output ?? item.aggregatedOutput);
  if (preview) projected.result = preview;
  if (Array.isArray(item.results)) projected.resultCount = item.results.length;
  return projected;
}

function copyMobileFields(target: JsonObject, source: JsonObject, keys: string[]): void {
  for (const key of keys) {
    if (source[key] == null) continue;
    const value = compactMobileValue(source[key]);
    if (value !== undefined) target[key] = value;
  }
}

function compactMobileValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return compactText(value, 12_000);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => compactMobileValue(item, depth + 1)).filter(item => item !== undefined);
  const object = objectValue(value);
  if (!object) return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object).slice(0, 40)) {
    if (/(?:token|secret|password|authorization|api[-_]?key)/i.test(key)) {
      result[key] = "[已隐藏]";
      continue;
    }
    const compacted = compactMobileValue(item, depth + 1);
    if (compacted !== undefined) result[key] = compacted;
  }
  return result;
}

function outputPreview(value: unknown): string {
  if (typeof value !== "string") return "";
  const firstLine = value.split(/\r?\n/).find(line => line.trim()) ?? "";
  return compactText(firstLine, 600);
}

function compactText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（手机端已截断）`;
}

function compactNotification(value: unknown): unknown {
  const object = objectValue(value);
  if (!object || typeof object.method !== "string") return value;
  const params = object.params === undefined ? undefined : compactMobileValue(object.params);
  const result: JsonObject = { method: object.method };
  if (params !== undefined) result.params = params;
  const raw = JSON.stringify(result);
  return raw.length <= 16_000 ? result : { method: object.method, params: { preview: compactText(raw, 12_000) } };
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

function broadcast(sockets: Set<WebSocket>, message: unknown, logger: GatewayLogger): void {
  const frame = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(frame);
    } catch (error) {
      logger.error("ws.broadcast_failed", { error });
    }
  }
}

function broadcastToThread(sockets: Set<WebSocket>, subscriptions: Map<WebSocket, string>, threadId: string, message: unknown, logger: GatewayLogger): void {
  const frame = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState !== 1 || subscriptions.get(socket) !== threadId) continue;
    try {
      socket.send(frame);
    } catch (error) {
      logger.error("ws.broadcast_failed", { error, threadId });
    }
  }
}

async function unsubscribeWithRetry(upstream: AppServerClient, threadId: string, logger: GatewayLogger, shouldRetry: () => boolean = () => true): Promise<{ status: "notLoaded" | "notSubscribed" | "unsubscribed" }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UNSUBSCRIBE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await upstream.unsubscribeThread(threadId);
    } catch (error) {
      lastError = error;
      if (attempt >= UNSUBSCRIBE_RETRY_ATTEMPTS) break;
      if (!shouldRetry()) throw error;
      const delayMs = UNSUBSCRIBE_RETRY_DELAYS_MS[attempt - 1] ?? UNSUBSCRIBE_RETRY_DELAYS_MS.at(-1)!;
      logger.warn("thread.unsubscribe_retry", { threadId, attempt, retryInMs: delayMs, error });
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
