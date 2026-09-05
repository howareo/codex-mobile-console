import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerClient, AppServerReconnectScheduledError } from "../src/protocol/app-server-client.js";
import { compareThreads, transcriptIsReadOnly } from "../src/probe/compare.js";
import { checkAppServerProtocol } from "../src/probe/protocol-health.js";
import type { AppServerFrame } from "../src/protocol/app-server-client.js";

describe("read-only app-server probe", () => {
  let server: WebSocketServer | undefined;
  let client: AppServerClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()));
    server = undefined;
  });

  it("initializes, preserves the read-only probe, then sends phase-2 methods", async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", socket => {
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString()) as { id?: number; method: string };
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { codexHome: "C:\\TestUser\\.codex", platformOs: "windows" } }));
        } else if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "thread-1", title: "Sample", cwd: "C:\\work", status: "idle" }] } }));
        } else if (message.method === "thread/loaded/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: ["thread-1"], nextCursor: null } }));
        } else if (message.method === "thread/read") {
          socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1", turns: [] } } }));
        } else if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "default", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null } }));
        } else if (message.method === "thread/resume") {
          socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1", turns: [], status: { type: "idle" } } } }));
        } else if (message.method === "thread/unsubscribe") {
          socket.send(JSON.stringify({ id: message.id, result: { status: "unsubscribed" } }));
        } else if (message.method === "thread/turns/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "turn-1", items: [] }], nextCursor: null, backwardsCursor: "back-1" } }));
        } else if (message.method === "turn/start") {
          socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } }));
        } else if (message.method === "turn/steer") {
          socket.send(JSON.stringify({ id: message.id, result: { turnId: "turn-1" } }));
        } else if (message.method === "turn/interrupt") {
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    });
    await new Promise<void>(resolve => server?.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not expose a port");
    const frames: AppServerFrame[] = [];
    client = new AppServerClient({ url: `ws://127.0.0.1:${address.port}`, onFrame: frame => frames.push(frame) });

    await expect(client.connect()).resolves.toMatchObject({ platformOs: "windows" });
    await expect(client.listThreads()).resolves.toMatchObject({ data: [{ id: "thread-1" }] });
    await expect(client.listLoadedThreads()).resolves.toEqual({ data: ["thread-1"], nextCursor: null });
    await expect(client.readThread("thread-1")).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(client.listThreadTurns("thread-1")).resolves.toMatchObject({ data: [{ id: "turn-1" }] });
    await expect(client.listModels()).resolves.toMatchObject({ data: [{ id: "gpt-5.6-sol" }] });
    expect(transcriptIsReadOnly(frames)).toBe(true);
    await expect(client.resumeThread("thread-1")).resolves.toMatchObject({ thread: { id: "thread-1", status: { type: "idle" } } });
    expect(frames.find(frame => frame.direction === "request" && frame.method === "thread/resume")?.message).toMatchObject({ params: { threadId: "thread-1", excludeTurns: true } });
    await expect(client.unsubscribeThread("thread-1")).resolves.toEqual({ status: "unsubscribed" });
    expect(frames.find(frame => frame.direction === "request" && frame.method === "thread/unsubscribe")?.message).toMatchObject({ params: { threadId: "thread-1" } });
    await expect(client.startTurn("thread-1", "hello", { model: "gpt-5.6-sol", effort: "high" })).resolves.toMatchObject({ turn: { id: "turn-1" } });
    expect(frames.find(frame => frame.direction === "request" && frame.method === "turn/start")?.message).toMatchObject({ params: { threadId: "thread-1", model: "gpt-5.6-sol", effort: "high" } });
    expect(frames.some(frame => frame.direction === "request" && frame.method === "thread/settings/update")).toBe(false);
    await expect(client.steerTurn("thread-1", "turn-1", "more")).resolves.toEqual({ turnId: "turn-1" });
    await expect(client.interruptTurn("thread-1", "turn-1")).resolves.toEqual({});
    await expect(client.request("thread/delete", {})).rejects.toThrow("unsupported app-server method");
  });

  it("shares one reconnect across concurrent callers and initializes the replacement socket", async () => {
    server = new WebSocketServer({ port: 0 });
    let connections = 0;
    let initializations = 0;
    let firstSocket: WebSocket | undefined;
    server.on("connection", socket => {
      connections++;
      if (!firstSocket) firstSocket = socket;
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString()) as { id?: number; method: string };
        if (message.method === "initialize") {
          initializations++;
          socket.send(JSON.stringify({ id: message.id, result: { platformOs: "windows" } }));
        }
      });
    });
    await new Promise<void>(resolve => server?.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not expose a port");
    client = new AppServerClient({
      url: `ws://127.0.0.1:${address.port}`,
      autoReconnect: true,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10
    });

    await client.connect();
    const closed = once(client, "close");
    firstSocket?.terminate();
    await closed;
    await Promise.all([client.ensureReady(), client.ensureReady(), client.ensureReady()]);

    expect(client.connectionState).toBe("open");
    expect(connections).toBe(2);
    expect(initializations).toBe(2);
  });

  it("keeps background reads behind reconnect backoff while foreground work can reconnect immediately", async () => {
    server = new WebSocketServer({ port: 0 });
    let connections = 0;
    let firstSocket: WebSocket | undefined;
    server.on("connection", socket => {
      connections++;
      if (!firstSocket) firstSocket = socket;
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString()) as { id?: number; method: string };
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { platformOs: "windows" } }));
      });
    });
    await new Promise<void>(resolve => server?.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not expose a port");
    client = new AppServerClient({
      url: `ws://127.0.0.1:${address.port}`,
      autoReconnect: true,
      reconnectBaseDelayMs: 80,
      reconnectMaxDelayMs: 80,
      random: () => 0.99
    });

    await client.connect();
    const closed = once(client, "close");
    firstSocket?.terminate();
    await closed;
    const reconnected = once(client, "connected");

    expect(client.reconnectScheduled).toBe(true);
    await expect(client.listThreadTurns("thread-1", null, 10, "background")).rejects.toBeInstanceOf(AppServerReconnectScheduledError);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(connections).toBe(1);

    await reconnected;
    expect(client.reconnectScheduled).toBe(false);
    expect(connections).toBe(2);
  });
});

describe("desktop task reconciliation", () => {
  it("does not invent mismatches for fields absent from the desktop snapshot", () => {
    expect(compareThreads([{ id: "same", title: "Same" }], [{ id: "same", title: "Same", cwd: "C:\\work", status: "idle" }]).pass).toBe(true);
  });

  it("reports missing, extra, and field mismatches by task id", () => {
    const result = compareThreads(
      [
        { id: "same", title: "Same", cwd: "C:\\work", status: "idle" },
        { id: "missing", title: "Missing" }
      ],
      [
        { id: "same", title: "Changed", cwd: "C:\\work", status: "idle" },
        { id: "extra", title: "Extra" }
      ]
    );
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(["missing"]);
    expect(result.extra).toEqual(["extra"]);
    expect(result.mismatches).toContainEqual({ id: "same", field: "title", desktop: "Same", appServer: "Changed" });
  });
});

describe("app-server protocol health", () => {
  it("requires both initialize and thread/list", async () => {
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", socket => {
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString()) as { id?: number; method: string };
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { codexHome: "C:\\TestUser\\.codex", platformOs: "windows" } }));
        } else if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "thread-1" }], nextCursor: null } }));
        }
      });
    });
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not expose a port");

    const result = await checkAppServerProtocol(`ws://127.0.0.1:${address.port}`, 2_000);
    expect(result).toMatchObject({ ok: true, initialize: true, threadList: true, threadCount: 1, platformOs: "windows" });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
