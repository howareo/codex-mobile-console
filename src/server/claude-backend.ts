import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import type { ServerResponse } from "node:http";
import { ClaudeReadError, ClaudeSessionStore } from "./claude-store.js";
import { ClaudeRuns } from "./claude-runs.js";
import { claudeOptionsSchema, localClaudeSettings } from "./claude-settings.js";

const sessionParams = z.object({ id: z.uuid() });
const requestBody = z.object({ requestId: z.uuid() }).strict();
const messageBody = requestBody.extend({ text: z.string().trim().min(1).max(16_000), options: claudeOptionsSchema.optional() });

export function createClaudeBackend(key: string, store = new ClaudeSessionStore(), runs = new ClaudeRuns(id => store.find(id), id => store.invalidate(id), undefined, undefined, async (id, cwd) => {
  const [settings, page] = await Promise.all([localClaudeSettings(cwd), store.read(id)]);
  return { ...settings, effective: { ...settings.effective, ...page.settings } };
})) {
  if (key.length < 32) throw new Error("Claude backend key is required");
  const app = Fastify({ logger: false, requestTimeout: 15_000, bodyLimit: 80_000 });
  const streams = new Set<ServerResponse>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (!["127.0.0.1:4600", "localhost:4600"].includes(request.headers.host || "") || request.headers.origin) {
      return reply.code(403).send({ error: "仅接受本机网关请求" });
    }
    if (request.method !== "GET" && !(request.method === "POST" && (["/shutdown", "/sessions"].includes(request.url) || /^\/sessions\/[^/]+\/(?:messages|stop|approvals\/[^/]+)$/.test(request.url)))) {
      return reply.code(405).send({ error: "不支持的 Claude 请求方法" });
    }
    if (request.url === "/healthz") return;
    const provided = request.headers["x-codex-mobile-claude-key"];
    if (typeof provided !== "string" || Buffer.byteLength(provided) !== Buffer.byteLength(key) || !timingSafeEqual(Buffer.from(provided), Buffer.from(key))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "请求格式有误，请刷新后重试" });
    const known = error instanceof ClaudeReadError;
    return reply.code(known ? error.statusCode : 503).send({ error: known ? error.message : "Claude 历史读取失败，请查看本机服务状态后重试" });
  });
  // Keep the legacy readOnly identity field for watchdogs already running before this upgrade.
  app.get("/healthz", async () => ({ service: "codex-mobile-claude", ok: true, readOnly: true, capabilities: { control: true, streaming: true, approvals: true, settings: true, telemetry: true, createSession: true }, pid: process.pid, sdkVersion: "0.3.316" }));
  app.post("/sessions", async request => {
    const { requestId, cwd } = requestBody.extend({ cwd: z.string().trim().min(1).max(4096) }).parse(request.body);
    return store.create(requestId, cwd);
  });
  app.get<{ Querystring: { cursor?: string } }>("/sessions", async request => {
    const page = await store.list(request.query.cursor);
    const statuses = await runs.statuses();
    return { ...page, data: page.data.map(session => ({ ...session, status: statuses.get(session.id) || session.status })) };
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>("/sessions/:id", async request => store.read(request.params.id, request.query.cursor));
  app.get("/sessions/:id/settings", async request => runs.settings(sessionParams.parse(request.params).id));
  app.post("/sessions/:id/messages", async request => {
    const { id } = sessionParams.parse(request.params);
    const { text, requestId, options } = messageBody.parse(request.body);
    return runs.send(id, text, requestId, options);
  });
  app.post("/sessions/:id/stop", async request => {
    const { id } = sessionParams.parse(request.params);
    return runs.stop(id, requestBody.parse(request.body).requestId);
  });
  app.post("/sessions/:id/approvals/:approvalId", async request => {
    const { id, approvalId } = sessionParams.extend({ approvalId: z.uuid() }).parse(request.params);
    const { requestId, allow, answers } = requestBody.extend({ allow: z.boolean(), answers: z.record(z.string().max(1000), z.string().trim().min(1).max(2000)).optional() }).parse(request.body);
    return runs.decide(id, requestId, approvalId, allow, answers);
  });
  app.get("/events", async (_request, reply) => {
    const write = (value: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (reply.raw.writableLength > 1_000_000) { reply.raw.destroy(); return; }
      reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    const unsubscribe = runs.subscribe(run => write({ run }));
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    write({ runs: runs.snapshots().map(run => run.finishedAt === null ? run : { ...run, messages: [] }) });
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": keepalive\n\n"); }, 15_000);
    reply.raw.once("close", () => { clearInterval(heartbeat); streams.delete(reply.raw); unsubscribe(); });
  });
  app.post("/shutdown", async () => {
    setImmediate(() => { void app.close(); });
    return { ok: true };
  });
  app.addHook("preClose", async () => { runs.close(); for (const stream of streams) stream.end(); });
  return app;
}
