import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { CLAUDE_BACKEND_URL, claudeBackendKey } from "./claude-transport.js";
import { claudeOptionsSchema } from "./claude-settings.js";

export function registerClaudeProxy(app: FastifyInstance, requireSession: preHandlerHookHandler, pairingSecret: string,
  transport: typeof fetch = fetch): void {
  const key = claudeBackendKey(pairingSecret);
  const streams = new Set<AbortController>();
  app.addHook("preClose", async () => { for (const controller of streams) controller.abort(); });
  const proxy = async (path: string, payload?: unknown) => {
    try {
      const response = await transport(`${CLAUDE_BACKEND_URL}${path}`, {
        headers: { "x-codex-mobile-claude-key": key, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { method: "POST", body: JSON.stringify(payload) }), signal: AbortSignal.timeout(12_000), redirect: "error"
      });
      const body = await response.text();
      if (body.length > 1_000_000) throw new Error("Claude response exceeded limit");
      return { status: response.status, body: JSON.parse(body) as unknown };
    } catch {
      return { status: 503, body: { error: "Claude 服务暂未连接；Codex 不受影响。请检查本机 4600 服务。发送失败时先刷新确认，避免重复提交" } };
    }
  };
  app.get("/api/claude/status", { preHandler: requireSession }, async (_request, reply) => {
    const result = await proxy("/healthz");
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
  app.get<{ Querystring: { cursor?: string } }>("/api/claude/sessions", { preHandler: requireSession }, async (request, reply) => {
    if (request.query.cursor !== undefined && !/^\d{1,4}$/.test(request.query.cursor)) return reply.code(400).send({ error: "无效的分页位置" });
    const result = await proxy(`/sessions${request.query.cursor === undefined ? "" : `?cursor=${request.query.cursor}`}`);
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
  app.post("/api/claude/sessions", { preHandler: requireSession }, async (request, reply) => {
    if (request.headers.origin !== `${request.protocol}://${request.headers.host}`) return reply.code(403).send({ error: "仅接受当前页面发起的操作，请刷新后重试" });
    const parsed = z.object({ requestId: z.uuid(), cwd: z.string().trim().min(1).max(4096) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请选择有效工作目录后重试" });
    const result = await proxy("/sessions", parsed.data);
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>("/api/claude/sessions/:id", { preHandler: requireSession }, async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return reply.code(400).send({ error: "无效的 Claude 会话编号" });
    const result = await proxy(`/sessions/${encodeURIComponent(request.params.id)}${request.query.cursor === undefined ? "" : `?cursor=${encodeURIComponent(request.query.cursor)}`}`);
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
  app.get<{ Params: { id: string } }>("/api/claude/sessions/:id/settings", { preHandler: requireSession }, async (request, reply) => {
    if (!z.uuid().safeParse(request.params.id).success) return reply.code(400).send({ error: "无效的 Claude 会话编号" });
    const result = await proxy(`/sessions/${request.params.id}/settings`);
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
  for (const action of ["messages", "stop", "approvals/:approvalId"] as const) {
    app.post<{ Params: { id: string; approvalId?: string } }>(`/api/claude/sessions/:id/${action}`, { preHandler: requireSession, bodyLimit: 80_000 }, async (request, reply) => {
      if (request.headers.origin !== `${request.protocol}://${request.headers.host}`) return reply.code(403).send({ error: "仅接受当前页面发起的操作，请刷新后重试" });
      const params = z.object({ id: z.uuid(), approvalId: z.uuid().optional() }).safeParse(request.params);
      const schema = action === "messages" ? z.object({ requestId: z.uuid(), text: z.string().trim().min(1).max(16_000), options: claudeOptionsSchema.optional() }).strict()
        : action === "stop" ? z.object({ requestId: z.uuid() }).strict() : z.object({ requestId: z.uuid(), allow: z.boolean(), answers: z.record(z.string().max(1000), z.string().trim().min(1).max(2000)).optional() }).strict();
      const parsed = schema.safeParse(request.body);
      if (!params.success || !parsed.success) return reply.code(400).send({ error: "请求格式有误，请刷新后重试" });
      const path = action.startsWith("approvals/") ? `approvals/${params.data.approvalId}` : action;
      const result = await proxy(`/sessions/${params.data.id}/${path}`, parsed.data);
      return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
    });
  }
  app.get("/api/claude/events", { preHandler: requireSession }, async (_request, reply) => {
    const controller = new AbortController();
    streams.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12_000);
    reply.raw.once("close", () => { streams.delete(controller); controller.abort(); });
    try {
      const response = await transport(`${CLAUDE_BACKEND_URL}/events`, { headers: { "x-codex-mobile-claude-key": key }, signal: controller.signal, redirect: "error" });
      clearTimeout(timeout);
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        await response.body?.cancel();
        return reply.code(503).send({ error: "Claude 实时连接暂不可用" });
      }
      return reply.header("Content-Type", "text/event-stream").header("Cache-Control", "no-store").header("X-Accel-Buffering", "no")
        .send(Readable.fromWeb(response.body));
    } catch {
      return reply.code(503).send({ error: "Claude 实时连接已断开，页面将自动重连" });
    } finally { clearTimeout(timeout); }
  });
}
