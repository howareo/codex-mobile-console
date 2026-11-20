import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { query, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessionStore } from "../src/server/claude-store.js";
import { ClaudeRuns } from "../src/server/claude-runs.js";
import { createClaudeBackend } from "../src/server/claude-backend.js";
import { registerClaudeProxy } from "../src/server/claude-proxy.js";
import { claudeBackendKey } from "../src/server/claude-transport.js";
import { claudeStatusClass } from "../web/src/claude-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async importOriginal => ({ ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(), query: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), existsSync: vi.fn(() => true) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-mobile-create-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const api = { listSessions: vi.fn(async () => [] as SDKSessionInfo[]), getSessionInfo: vi.fn(async (_id: string) => undefined as SDKSessionInfo | undefined),
    readHistoryPage: vi.fn(async () => ({ messages: [], olderCursor: null })) };
  const file = join(root, "private", "created.json");
  return { root, cwd, api, file, store: new ClaudeSessionStore(api, file) };
}

describe("Claude mobile session creation", () => {
  it("persists empty sessions idempotently without starting a CLI and later reads their official history", async () => {
    const { cwd, api, file, store } = await fixture();
    const id = randomUUID();
    const first = await store.create(id, cwd);
    expect(first).toMatchObject({ id, cwd, pending: true });
    expect(await store.create(id, cwd)).toEqual(first);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
    expect(await store.read(id)).toMatchObject({ messages: [], olderCursor: null });
    expect(api.readHistoryPage).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    const restored = new ClaudeSessionStore(api, file);
    expect((await restored.list()).data).toEqual([first]);
    expect(api.listSessions).toHaveBeenCalledWith({ limit: 1000, includeProgrammatic: false });
    api.getSessionInfo.mockResolvedValue({ sessionId: id, cwd, summary: "第一条问题", lastModified: Date.now(), fileSize: 123 });
    restored.invalidate(id);
    expect((await restored.read(id)).session).toMatchObject({ id, title: "第一条问题" });
    expect((await restored.find(id)).pending).toBeUndefined();
    expect(api.readHistoryPage).toHaveBeenCalledWith(id, undefined);
  });

  it("serializes concurrent creation, rejects invalid directories and preserves a corrupt index", async () => {
    const { root, cwd, api, file, store } = await fixture();
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(ids.map(id => store.create(id, cwd)));
    expect((await store.list()).data.map(session => session.id).sort()).toEqual(ids.sort());
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);
    await expect(store.create(randomUUID(), "relative")).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.create(randomUUID(), join(root, "missing"))).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.create(ids[0]!, root)).rejects.toMatchObject({ statusCode: 409 });
    await writeFile(file, "invalid json");
    await expect(new ClaudeSessionStore(api, file).list()).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(file, "utf8")).toBe("invalid json");
  });

  it("uses sessionId for a first send, then resume for later sends, with local settings preserved", async () => {
    const id = randomUUID();
    let pending = true;
    vi.mocked(query).mockImplementation(() => Object.assign((async function* () {
      yield { type: "result", is_error: false, subtype: "success" };
    })(), { close: vi.fn() }) as unknown as ReturnType<typeof query>);
    const runs = new ClaudeRuns(async () => ({ id, title: "new", cwd: "C:\\project", updatedAt: 1, status: "unknown", pending }), vi.fn(), undefined,
      async () => new Set(), async () => ({ effective: { model: "local-model", effort: "high" }, models: [] }));
    try {
      const first = await runs.send(id, "first", randomUUID());
      await vi.waitFor(() => expect(first.finishedAt).not.toBeNull());
      expect(vi.mocked(query).mock.calls[0]?.[0].options).toMatchObject({ sessionId: id, model: "local-model", effort: "high" });
      expect(vi.mocked(query).mock.calls[0]?.[0].options).not.toHaveProperty("resume");
      pending = false;
      const second = await runs.send(id, "second", randomUUID());
      await vi.waitFor(() => expect(second.finishedAt).not.toBeNull());
      expect(vi.mocked(query).mock.calls[1]?.[0].options).toMatchObject({ resume: id });
      expect(vi.mocked(query).mock.calls[1]?.[0].options).not.toHaveProperty("sessionId");
    } finally { runs.close(); }
  });

  it("creates through the authenticated same-origin gateway and denies forged requests", async () => {
    const { cwd, store } = await fixture();
    const key = claudeBackendKey("s".repeat(32));
    const backend = createClaudeBackend(key, store);
    const gateway = Fastify();
    const transport = vi.fn<typeof fetch>(async (url, options) => {
      const result = await backend.inject({ method: "POST", url: new URL(String(url)).pathname, headers: { ...options!.headers as Record<string, string>, host: "127.0.0.1:4600" }, payload: options!.body as string });
      return new Response(result.body, { status: result.statusCode });
    });
    registerClaudeProxy(gateway, async (request, reply) => { if (request.headers.cookie !== "valid") await reply.code(401).send({ error: "unauthorized" }); }, "s".repeat(32), transport);
    const payload = { requestId: randomUUID(), cwd };
    const headers = { cookie: "valid", host: "localhost", origin: "http://localhost" };
    try {
      expect((await backend.inject({ url: "/healthz", headers: { host: "127.0.0.1:4600" } })).json().capabilities.createSession).toBe(true);
      expect((await gateway.inject({ method: "POST", url: "/api/claude/sessions", headers: { host: headers.host }, payload })).statusCode).toBe(401);
      expect((await gateway.inject({ method: "POST", url: "/api/claude/sessions", headers: { ...headers, origin: "http://evil.test" }, payload })).statusCode).toBe(403);
      expect((await gateway.inject({ method: "POST", url: "/api/claude/sessions", headers, payload: { ...payload, requestId: "bad" } })).statusCode).toBe(400);
      expect(transport).not.toHaveBeenCalled();
      const result = await gateway.inject({ method: "POST", url: "/api/claude/sessions", headers, payload });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ id: payload.requestId, cwd, pending: true });
      expect(result.body).not.toContain(key);
      expect(query).not.toHaveBeenCalled();
      expect((await backend.inject({ method: "POST", url: "/sessions", headers: { host: "127.0.0.1:4600" }, payload })).statusCode).toBe(401);
      expect((await backend.inject({ url: `/sessions/${payload.requestId}`, headers: { host: "127.0.0.1:4600", "x-codex-mobile-claude-key": key } })).json().messages).toEqual([]);
    } finally { await gateway.close(); await backend.close(); }
  });

  it.each(["starting", "running", "stopping", "approval"])("maps %s to the shared Codex running color", status => {
    expect(claudeStatusClass(status)).toBe("running");
    expect(claudeStatusClass("completed")).toBe("done");
    expect(claudeStatusClass("stopped")).toBe("done");
    expect(claudeStatusClass("failed")).toBe("failed");
  });
});
