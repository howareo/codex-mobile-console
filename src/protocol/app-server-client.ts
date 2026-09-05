import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type {
  InitializeResult,
  ModelListResult,
  RpcId,
  RpcNotification,
  RpcResponse,
  ThreadLoadedListResult,
  ThreadListResult,
  ThreadReadResult,
  ThreadResumeResult,
  ThreadTurnsListResult,
  ThreadUnsubscribeResult,
  TurnResult,
  TurnSteerResult
} from "../shared/types.js";

const CLIENT_METHODS = new Set(["thread/list", "thread/loaded/list", "thread/read", "thread/resume", "thread/unsubscribe", "thread/turns/list", "model/list", "turn/start", "turn/steer", "turn/interrupt"]);

export type AppServerRequestPriority = "foreground" | "background";

export class AppServerReconnectScheduledError extends Error {
  public readonly code = "APP_SERVER_RECONNECT_SCHEDULED";

  public constructor(public readonly retryAfterMs: number) {
    super(`app-server reconnect is scheduled in ${retryAfterMs}ms`);
    this.name = "AppServerReconnectScheduledError";
  }
}

export interface AppServerFrame {
  direction: "request" | "response" | "notification" | "serverRequest";
  message: unknown;
  raw: string;
  method?: string;
  durationMs?: number;
  ok?: boolean;
}

export interface AppServerClientOptions {
  url: string;
  clientInfo?: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
  timeoutMs?: number;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  random?: () => number;
  onFrame?: (frame: AppServerFrame) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
}

export class AppServerClient extends EventEmitter {
  private readonly options: Required<Pick<AppServerClientOptions, "url" | "timeoutMs">> & AppServerClientOptions;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<InitializeResult> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextReconnectAt: number | null = null;
  private reconnectAttempt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private closed = true;
  private hasConnected = false;
  private _initializeResult: InitializeResult | null = null;

  public constructor(options: AppServerClientOptions) {
    super();
    assertLoopbackWebSocket(options.url);
    this.options = { timeoutMs: 20_000, ...options };
  }

  public get initializeResult(): InitializeResult | null {
    return this._initializeResult;
  }

  public get connectionState(): "connecting" | "open" | "reconnecting" | "closed" {
    if (!this.socket) {
      if (this.connectPromise || this.reconnectTimer) return this.hasConnected ? "reconnecting" : "connecting";
      return "closed";
    }
    if (this.socket.readyState === WebSocket.OPEN) return "open";
    return this.hasConnected ? "reconnecting" : "connecting";
  }

  public get pendingRequestCount(): number {
    return this.pending.size;
  }

  public get reconnectScheduled(): boolean {
    return this.reconnectTimer !== null;
  }

  public get reconnectRetryAfterMs(): number | null {
    return this.nextReconnectAt == null ? null : Math.max(0, this.nextReconnectAt - Date.now());
  }

  public async connect(): Promise<InitializeResult> {
    this.closed = false;
    return this.ensureReady();
  }

  public async ensureReady(priority: AppServerRequestPriority = "foreground"): Promise<InitializeResult> {
    if (this.initialized && this.socket?.readyState === WebSocket.OPEN && this._initializeResult) return this._initializeResult;
    if (this.closed) throw new Error("app-server client is closed");
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer) {
      if (priority === "background") throw new AppServerReconnectScheduledError(this.reconnectRetryAfterMs ?? 0);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.nextReconnectAt = null;
    }
    const promise = this.openAndInitialize();
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  private async openAndInitialize(): Promise<InitializeResult> {
    const previous = this.socket;
    if (previous) {
      this.socket = null;
      this.initialized = false;
      this.rejectPending(new Error("app-server connection was replaced"));
      previous.terminate();
    }
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          socket.off("open", onOpen);
          socket.off("error", onError);
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
      });
      if (this.closed || this.socket !== socket) throw new Error("app-server connection was superseded");
      socket.on("message", (raw: RawData) => this.handleMessage(socket, raw.toString()));
      socket.on("close", () => this.handleClose(socket, new Error("app-server WebSocket closed")));
      socket.on("error", (error: Error) => this.emitClientError(error));

      const result = await this.requestInternal<InitializeResult>("initialize", {
        clientInfo: this.options.clientInfo ?? {
          name: "codex-mobile-console",
          title: "Codex Mobile Console",
          version: "0.1.0"
        },
        capabilities: this.options.capabilities ?? { experimentalApi: false }
      });
      this._initializeResult = result;
      this.initialized = true;
      this.sendNotification("initialized", {});
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.reconnectAttempt = 0;
      this.nextReconnectAt = null;
      this.emit("connected", { reconnected });
      return result;
    } catch (error) {
      if (this.socket === socket) this.handleClose(socket, error instanceof Error ? error : new Error(String(error)));
      socket.terminate();
      throw error;
    }
  }

  public async listThreads(cursor?: string | null): Promise<ThreadListResult> {
    return this.request<ThreadListResult>("thread/list", {
      limit: 50,
      cursor: cursor ?? null,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
      useStateDbOnly: true
    });
  }

  public async listLoadedThreads(cursor?: string | null): Promise<ThreadLoadedListResult> {
    return this.request<ThreadLoadedListResult>("thread/loaded/list", {
      limit: 100,
      cursor: cursor ?? null
    });
  }

  public async readThread(threadId: string): Promise<ThreadReadResult> {
    return this.request<ThreadReadResult>("thread/read", { threadId, includeTurns: true });
  }

  public async readThreadMetadata(threadId: string, priority: AppServerRequestPriority = "foreground"): Promise<ThreadReadResult> {
    return this.request<ThreadReadResult>("thread/read", { threadId, includeTurns: false }, priority);
  }

  // 继续持久化任务前先恢复到共享 app-server；不携带历史，避免大会话重复传输。
  public async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    return this.request<ThreadResumeResult>("thread/resume", { threadId, excludeTurns: true });
  }

  public async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResult> {
    return this.request<ThreadUnsubscribeResult>("thread/unsubscribe", { threadId });
  }

  public async listModels(cursor?: string | null, includeHidden = false): Promise<ModelListResult> {
    return this.request<ModelListResult>("model/list", { cursor: cursor ?? null, limit: 100, includeHidden });
  }

  public async listThreadTurns(threadId: string, cursor?: string | null, limit = 10, priority: AppServerRequestPriority = "foreground"): Promise<ThreadTurnsListResult> {
    return this.request<ThreadTurnsListResult>("thread/turns/list", {
      threadId,
      cursor: cursor ?? null,
      limit,
      sortDirection: "desc",
      itemsView: "full"
    }, priority);
  }

  public async startTurn(threadId: string, text: string, settings: { model?: string | null; effort?: string | null } = {}): Promise<TurnResult> {
    return this.request<TurnResult>("turn/start", { threadId, input: [{ type: "text", text }], ...settings });
  }

  public async steerTurn(threadId: string, turnId: string, text: string): Promise<TurnSteerResult> {
    return this.request<TurnSteerResult>("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }]
    });
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>("turn/interrupt", { threadId, turnId });
  }

  public async request<T>(method: string, params: unknown, priority: AppServerRequestPriority = "foreground"): Promise<T> {
    if (!CLIENT_METHODS.has(method)) {
      throw new Error(`unsupported app-server method: ${method}`);
    }
    await this.ensureReady(priority);
    return this.requestInternal<T>(method, params);
  }

  public respondToServerRequest(id: RpcId, result: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("app-server WebSocket is not open");
    const message = { id, result };
    const raw = JSON.stringify(message);
    this.options.onFrame?.({ direction: "response", message, raw, ok: true });
    this.emit("frame", { direction: "response", message, raw, ok: true } satisfies AppServerFrame);
    socket.send(raw);
  }

  public close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextReconnectAt = null;
    const socket = this.socket;
    this.socket = null;
    this.initialized = false;
    this.rejectPending(new Error("app-server client closed"));
    socket?.terminate();
  }

  private requestInternal<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server WebSocket is not open"));
    }
    const id = this.nextId++;
    const message = { method, id, params };
    const raw = JSON.stringify(message);
    this.options.onFrame?.({ direction: "request", message, raw, method });
    this.emit("frame", { direction: "request", message, raw, method } satisfies AppServerFrame);
    socket.send(raw);
    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`app-server request timed out: ${method}`);
        this.emit("requestTimeout", { id, method, durationMs: Date.now() - startedAt });
        reject(error);
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, method, startedAt });
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("app-server WebSocket is not open");
    const message = { method, params };
    const raw = JSON.stringify(message);
    this.options.onFrame?.({ direction: "notification", message, raw, method });
    this.emit("frame", { direction: "notification", message, raw, method } satisfies AppServerFrame);
    socket.send(raw);
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    if (this.socket !== socket) return;
    let message: RpcResponse | (RpcNotification & { id?: RpcId });
    try {
      message = JSON.parse(raw) as typeof message;
    } catch (error) {
      this.emitClientError(new Error(`invalid app-server JSON: ${String(error)}`));
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const response = message as RpcResponse;
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emitClientError(new Error(`unexpected app-server response id: ${message.id}`));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const durationMs = Date.now() - pending.startedAt;
      const frame = { direction: "response", message, raw, method: pending.method, durationMs, ok: !response.error } satisfies AppServerFrame;
      if (response.error) {
        const error = new Error(`${response.error.code}: ${response.error.message}`) as Error & { code?: number; data?: unknown; statusCode?: number };
        error.code = response.error.code;
        error.data = response.error.data;
        const status = response.error.message.match(/\bstatus(?:\s+code)?\s*[:=]?\s*(4\d{2}|5\d{2})\b/i);
        if (status) error.statusCode = Number(status[1]);
        pending.reject(error);
        this.options.onFrame?.(frame);
        this.emit("frame", frame);
        return;
      }
      pending.resolve(response.result);
      this.options.onFrame?.(frame);
      this.emit("frame", frame);
      return;
    }
    const frame: AppServerFrame = {
      direction: "method" in message && typeof message.method === "string" && isRpcId(message.id) ? "serverRequest" : "notification",
      message,
      raw
    };
    if ("method" in message && typeof message.method === "string") frame.method = message.method;
    this.options.onFrame?.(frame);
    this.emit(frame.direction, message);
    this.emit("frame", frame);
  }

  private handleClose(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.initialized = false;
    this.rejectPending(error);
    this.emit("close", error);
    this.scheduleReconnect();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.options.autoReconnect || this.reconnectTimer) return;
    const base = this.options.reconnectBaseDelayMs ?? 1_000;
    const maximum = this.options.reconnectMaxDelayMs ?? 30_000;
    const ceiling = Math.min(maximum, base * (2 ** this.reconnectAttempt));
    const delayMs = Math.floor((this.options.random?.() ?? Math.random()) * ceiling);
    this.reconnectAttempt++;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.nextReconnectAt = Date.now() + delayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = null;
      void this.ensureReady().catch(error => this.emitClientError(error instanceof Error ? error : new Error(String(error))));
    }, delayMs);
  }

  private emitClientError(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

export function assertLoopbackWebSocket(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("app-server URL must use ws:// or wss://");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("raw app-server must remain on a loopback host");
  }
}
