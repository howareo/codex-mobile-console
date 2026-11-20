import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionStore, projectClaudeMessage, type ClaudeReadApi } from "../src/server/claude-store.js";
import { projectClaudePage } from "../src/server/claude-history.js";
import { createClaudeBackend } from "../src/server/claude-backend.js";
import { claudeBackendKey } from "../src/server/claude-transport.js";
import { registerClaudeProxy } from "../src/server/claude-proxy.js";

const id = "11111111-1111-4111-8111-111111111111";
const uuid = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
const info: SDKSessionInfo = { sessionId: id, summary: "测试会话", cwd: "C:\\project", lastModified: 1000, fileSize: 1000 };
const message = (index: number, content: unknown, type: "user" | "assistant" = "assistant"): SessionMessage => ({
  type, uuid: uuid(index), session_id: id, parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content }
});
const api = (messages: SessionMessage[] = []): ClaudeReadApi => ({
  listSessions: vi.fn(async () => [info]), readHistoryPage: vi.fn(async (_id, cursor) => projectClaudePage(messages, cursor))
});

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

describe("Claude read-only session adapter", () => {
  it("uses bounded pagination with stable history anchors and coalesces SDK reads", async () => {
    const source = api(Array.from({ length: 65 }, (_, index) => message(index, `reply-${index}`)));
    const store = new ClaudeSessionStore(source);
    const lists = await Promise.all([store.list(), store.list()]);
    expect(lists[0]).toMatchObject({ readOnly: true, data: [{ status: "unknown" }] });
    expect(source.listSessions).toHaveBeenCalledTimes(1);
    const [page, duplicate] = await Promise.all([store.read(id), store.read(id)]);
    expect(duplicate).toEqual(page);
    expect(source.readHistoryPage).toHaveBeenCalledTimes(1);
    expect(page.messages).toHaveLength(30);
    expect(page.messages[0]!.id).toBe(uuid(35));
    const older = await store.read(id, page.olderCursor!);
    expect(older.messages[0]!.id).toBe(uuid(5));
    expect(older.messages.at(-1)!.id).toBe(uuid(34));
    expect(source.readHistoryPage).toHaveBeenCalledTimes(2);
    await store.read(id);
    expect(source.readHistoryPage).toHaveBeenCalledTimes(2);
    await expect(store.read(id, uuid(999))).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.read("../settings.json")).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.read(id, "../../../")).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.list("-1")).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.list("9999")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reads real-sized large sessions while retaining a bounded file protection limit", async () => {
    const source = api([message(0, "large history")]);
    source.listSessions = vi.fn(async () => [{ ...info, fileSize: 54 * 1024 * 1024 }]);
    expect((await new ClaudeSessionStore(source).read(id)).messages).toHaveLength(1);
    source.listSessions = vi.fn(async () => [{ ...info, fileSize: 129 * 1024 * 1024 }]);
    vi.mocked(source.readHistoryPage).mockClear();
    await expect(new ClaudeSessionStore(source).read(id)).rejects.toMatchObject({ statusCode: 413 });
    expect(source.readHistoryPage).not.toHaveBeenCalled();
    const { fileSize: _size, ...withoutSize } = info;
    source.listSessions = vi.fn(async () => [withoutSize]);
    await expect(new ClaudeSessionStore(source).read(id)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("permits one history parse at a time and releases the slot after failure", async () => {
    const source = api();
    let fail!: (error: Error) => void;
    vi.mocked(source.readHistoryPage).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const store = new ClaudeSessionStore(source);
    await store.list();
    const reading = store.read(id);
    const failure = expect(reading).rejects.toThrow("parse failed");
    await Promise.resolve();
    await expect(store.read(id, uuid(0))).rejects.toMatchObject({ statusCode: 429 });
    fail(new Error("parse failed"));
    await failure;
    expect((await store.read(id)).messages).toEqual([]);
  });

  it("maps text, disclosed thinking, tool input/results and unknown blocks without raw signatures or secrets", () => {
    const result = projectClaudeMessage(message(0, [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "visible reasoning", signature: "DO_NOT_EXPORT" },
      { type: "tool_use", id: "call-1", name: "Read", input: { path: "file.ts", api_key: "DO_NOT_EXPORT" } },
      { type: "tool_result", tool_use_id: "call-1", is_error: true, content: [{ type: "text", text: "permission denied" }] },
      { type: "redacted_thinking", data: "DO_NOT_EXPORT" },
      { type: "new_future_block", private: "DO_NOT_EXPORT" }
    ]));
    expect(result.items).toHaveLength(6);
    expect(result.items[1]).toMatchObject({ type: "reasoning", summary: ["visible reasoning"] });
    expect(result.items[3]).toMatchObject({ type: "dynamicToolCall", status: "failed", toolUseId: "call-1", result: "permission denied" });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
    expect(projectClaudeMessage({ ...message(1, "hello", "user"), parent_tool_use_id: "parent" }).items[0]).toMatchObject({ type: "userMessage", text: "hello" });
    expect(projectClaudeMessage({ ...message(2, []), message: null }).items[0]).toMatchObject({ type: "unknown" });
  });

  it("keeps injected notifications and peer messages out of human chat bubbles", () => {
    const notification = "<task-notification>\n<task-id>background-1</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>\nRead the output file.";
    for (const [content, metadata] of [
      [notification, {}],
      [[{ type: "text", text: notification }], {}],
      ["background result", { origin: { kind: "task-notification" }, is_meta: true }],
      ["another agent's reply", { origin: { kind: "peer", from: "agent-1" } }],
      ["hook context", { is_meta: true }],
      ["synthetic context", { isSynthetic: true }]
    ] as const) {
      const entry = { ...message(0, content, "user"), ...metadata };
      expect(projectClaudePage([entry])).toMatchObject({ olderCursor: null, messages: [{ id: entry.uuid, items: [{ type: "dynamicToolCall" }] }] });
      expect(projectClaudeMessage(entry).items[0]).not.toHaveProperty("text");
    }
    for (const entry of [
      message(1, "real user prompt", "user"),
      message(2, "Explain this example: " + notification, "user"),
      { ...message(3, notification, "user"), origin: { kind: "human" } }
    ]) expect(projectClaudeMessage(entry).items[0]).toMatchObject({ type: "userMessage" });
    const toolResult = projectClaudeMessage({ ...message(4, [{ type: "tool_result", tool_use_id: "call-1", content: "output" }], "user"), isSynthetic: true });
    expect(toolResult.items[0]).toMatchObject({ type: "dynamicToolCall", tool: "工具结果", result: "output" });
  });

  it("allows only authenticated loopback gateway requests and validates session creation", async () => {
    const key = claudeBackendKey("s".repeat(32));
    const app = createClaudeBackend(key, new ClaudeSessionStore(api()));
    const headers = { host: "127.0.0.1:4600", "x-codex-mobile-claude-key": key };
    try {
      expect((await app.inject({ url: "/sessions", headers })).statusCode).toBe(200);
      for (const invalid of [{ host: "evil.example:4600" }, { ...headers, origin: "http://evil.example" }, { host: headers.host }, { ...headers, "x-codex-mobile-claude-key": "界".repeat(64) }]) {
        const result = await app.inject({ url: "/sessions", headers: invalid });
        expect([401, 403]).toContain(result.statusCode);
        expect(result.headers["access-control-allow-origin"]).toBeUndefined();
      }
      expect((await app.inject({ method: "POST", url: "/sessions", headers })).statusCode).toBe(400);
      expect((await app.inject({ method: "OPTIONS", url: "/sessions", headers })).statusCode).toBe(405);
    } finally { await app.close(); }
  });

  it("keeps the gateway auth boundary, adds its own key, and isolates backend failures", async () => {
    const app = Fastify();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [], nextCursor: null, readOnly: true })));
    registerClaudeProxy(app, async (request, reply) => { if (request.headers.cookie !== "valid") await reply.code(401).send({ error: "unauthorized" }); }, "s".repeat(32), transport);
    try {
      expect((await app.inject({ url: "/api/claude/sessions" })).statusCode).toBe(401);
      expect(transport).not.toHaveBeenCalled();
      const result = await app.inject({ url: "/api/claude/sessions", headers: { cookie: "valid", "x-codex-mobile-claude-key": "browser-forgery" } });
      expect(result.statusCode).toBe(200);
      expect(transport.mock.calls[0]![1]!.headers).toEqual({ "x-codex-mobile-claude-key": claudeBackendKey("s".repeat(32)) });
      expect(result.body).not.toContain(claudeBackendKey("s".repeat(32)));
      transport.mockRejectedValueOnce(new Error("offline"));
      expect((await app.inject({ url: "/api/claude/sessions", headers: { cookie: "valid" } })).statusCode).toBe(503);
    } finally { await app.close(); }
  });

  it("official SDK reads the active branch and partial JSONL tail without processes, network or writes", async () => {
    const root = await fsp.mkdtemp(join(tmpdir(), "codex-mobile-claude-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const cwd = join(root, "workspace");
      const directory = join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      await fsp.mkdir(directory, { recursive: true });
      const records = [
        { type: "user", uuid: uuid(0), parentUuid: null, message: { role: "user", content: "first prompt" } },
        { type: "assistant", uuid: uuid(1), parentUuid: uuid(0), message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
        { type: "user", uuid: uuid(2), parentUuid: uuid(1), message: { role: "user", content: "discarded branch" } },
        { type: "assistant", uuid: uuid(3), parentUuid: uuid(2), message: { role: "assistant", content: [{ type: "text", text: "discarded answer" }] } },
        { type: "user", uuid: uuid(4), parentUuid: uuid(1), message: { role: "user", content: "active branch" } },
        { type: "assistant", uuid: uuid(5), parentUuid: uuid(4), message: { role: "assistant", content: [{ type: "text", text: "active answer" }] } },
        { type: "user", uuid: uuid(6), parentUuid: uuid(5), origin: { kind: "task-notification" }, message: { role: "user", content: "background task finished" } },
        { type: "assistant", uuid: uuid(7), parentUuid: uuid(6), message: { role: "assistant", content: [{ type: "text", text: "acknowledged" }] } }
      ].map((record, index) => ({ ...record, sessionId: id, cwd, isSidechain: false, version: "2.1.316", timestamp: new Date(1700000000000 + index * 1000).toISOString() }));
      const path = join(directory, `${id}.jsonl`);
      await fsp.writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + '\n{"type":"assistant"');
      const before = createHash("sha256").update(await fsp.readFile(path)).digest("hex");
      const mtime = (await fsp.stat(path)).mtimeMs;
      const forbidden = () => { throw new Error("READ_ONLY_BOUNDARY_VIOLATION"); };
      const spies = [vi.spyOn(childProcess, "spawn").mockImplementation(forbidden), vi.spyOn(childProcess, "exec").mockImplementation(forbidden),
        vi.spyOn(childProcess, "execFile").mockImplementation(forbidden), vi.spyOn(childProcess, "fork").mockImplementation(forbidden),
        vi.spyOn(net, "connect").mockImplementation(forbidden), vi.spyOn(net, "createConnection").mockImplementation(forbidden),
        vi.spyOn(globalThis, "fetch").mockImplementation(forbidden),
        vi.spyOn(fsp, "writeFile").mockImplementation(forbidden), vi.spyOn(fsp, "appendFile").mockImplementation(forbidden),
        vi.spyOn(fsp, "mkdir").mockImplementation(forbidden), vi.spyOn(fsp, "rename").mockImplementation(forbidden),
        vi.spyOn(fsp, "unlink").mockImplementation(forbidden), vi.spyOn(fs, "writeFileSync").mockImplementation(forbidden)];
      syncBuiltinESMExports();
      try {
        const sessions = await listSessions({ limit: 30, includeProgrammatic: true });
        expect(sessions.some(session => session.sessionId === id)).toBe(true);
        const messages = await getSessionMessages(id);
        expect(messages.map(entry => entry.uuid)).toEqual([uuid(0), uuid(1), uuid(4), uuid(5), uuid(6), uuid(7)]);
        expect(projectClaudeMessage(messages[4]!).items[0]).toMatchObject({ type: "dynamicToolCall", tool: "Claude 系统通知", result: "background task finished" });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(createHash("sha256").update(await fsp.readFile(path)).digest("hex")).toBe(before);
        expect((await fsp.stat(path)).mtimeMs).toBe(mtime);
      } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
