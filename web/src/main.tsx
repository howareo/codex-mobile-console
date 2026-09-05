import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Circle,
  CircleCheck,
  Clock3,
  FilePenLine,
  FolderClosed,
  Gauge,
  Image,
  LayoutList,
  ListChecks,
  LoaderCircle,
  LogOut,
  RadioTower,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldX,
  Square,
  Terminal,
  Wrench,
  Wifi,
  WifiOff
} from "lucide-react";
import type { ApprovalRequest, InitializeResult, JsonObject, LoadedTasksDiagnosticsResult, ModelListResult, ModelSummary, ReasoningOverrides, RpcNotification, ThreadMetadataResult, ThreadPageResult, ThreadSummary } from "../../src/shared/types";
import { mergeThreadPage } from "./thread-history";
import { isConversationItem, itemDetails, itemId, itemRecord, itemRole, itemSummary, itemText, itemType, statusClass, statusText, statusValue, toolLabel } from "./thread-items";
import { formatConversationTime, formatDurationMs, timestampMs, turnDurationMs } from "./time-format";
import { clearClientCaches, clearThreadOverride, mergeThreadMetadata, mergeThreadSummary, pollIntervalMs, readClientCache, realtimeThreadId, resumeDecision, shouldReportAuthExpired, writeClientCache, type AuthSessionInfo } from "./pwa-state";
import { interruptErrorText, sendErrorText, turnErrorText } from "./error-text";
import { latestPlanFromTurn, planNotification, planProgress, planSnapshotKey, type PlanSnapshot, type PlanStep } from "./plan-state";
import "./styles.css";

type View = "threads" | "live" | "settings";
type AuthState = "checking" | "signedOut" | "signedIn";
type DiagnosticLevel = "info" | "warn" | "error";
type RealtimeState = "open" | "reconnecting" | "polling" | "offline";
type ThreadActionKind = "send" | "interrupt";
interface ThreadActionState {
  kind: ThreadActionKind;
  busy: boolean;
  error: string | null;
  notice?: string | null;
  requestId?: string;
  message?: string;
}
type TurnBlock = { kind: "item"; item: unknown } | { kind: "activity"; items: unknown[] };
interface DiagnosticsStatus {
  upstream: { state: string; pendingRequests: number };
  realtime: { sockets: number; subscriptions: number; snapshotsRunning: boolean; threadPagesInFlight: number; lastSnapshotAt: string | null; lastSnapshotErrorAt: string | null; mode: string };
  writes: { activeThreads: number };
  stability?: {
    windowMs: number;
    upstream: { requests: number; failures: number; timeouts: number; successRate: number | null; p95Ms: number | null; p99Ms: number | null };
    snapshots: { runs: number; failures: number; successRate: number | null; p95Ms: number | null };
    reconnects: number;
  };
  config?: {
    state: "pending" | "applied" | "unknown";
    pendingFingerprint: string | null;
    appliedFingerprint: string | null;
    requestedAt: string | null;
  };
  unsubscribeFailures?: Array<{ threadId: string; attempts: number; lastErrorAt: string }>;
  log: { enabled: boolean; fileName: string | null };
}
interface WriteReceiptResponse {
  requestId: string;
  acceptedAt: string;
  mode: "start" | "steer";
  model?: string | null;
  reasoningEffort?: string | null;
}
const CLIENT_BUILD = "2026.08.12.02";
const AUTH_EXPIRED_EVENT = "codex-mobile-auth-expired";
const API_TIMEOUT_MS = 30_000;
const EVENT_FLUSH_MS = 120;
let authGeneration = 0;

function reportClientDiagnostic(level: DiagnosticLevel, event: string, details: JsonObject = {}): void {
  void fetch("/api/diagnostics/client", {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level, event, details })
  }).catch(() => undefined);
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const requestGeneration = authGeneration;
  const controller = new AbortController();
  const externalSignal = init?.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromCaller();
    else externalSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(path, { credentials: "include", ...init, signal: controller.signal, headers: { "content-type": "application/json", ...init?.headers } });
  } catch (cause) {
    if (timedOut) {
      const timeoutError = new Error(`请求超时（${init?.method || "GET"} ${diagnosticRoute(path)}），请稍后重试`);
      reportClientDiagnostic("error", "api.timeout", { route: diagnosticRoute(path), method: init?.method || "GET", timeoutMs });
      throw timeoutError;
    }
    if (!isAbortError(cause)) reportClientDiagnostic("error", "api.network_error", { route: diagnosticRoute(path), method: init?.method || "GET", errorName: cause instanceof Error ? cause.name : "unknown" });
    throw cause;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) {
    if (response.status !== 401 || path !== "/api/auth/session") reportClientDiagnostic(response.status >= 500 ? "error" : "warn", "api.response_error", { route: diagnosticRoute(path), method: init?.method || "GET", statusCode: response.status });
    if (shouldReportAuthExpired(requestGeneration, authGeneration, response.status, path)) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
      else if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Keep plain-text and Fastify HTML responses useful as well.
    }
    const error = new Error(detail || response.statusText || `HTTP ${response.status}`) as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === "AbortError") || (cause instanceof Error && cause.name === "AbortError");
}

function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [view, setView] = useState<View>("threads");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ThreadPageResult | null>(null);
  const [events, setEvents] = useState<RpcNotification[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [server, setServer] = useState<InitializeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("offline");
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [syncingThreads, setSyncingThreads] = useState(false);
  const [pageVisibility, setPageVisibility] = useState<DocumentVisibilityState>(document.visibilityState);
  const [highContrast, setHighContrast] = useState(() => window.localStorage.getItem("codex-mobile-high-contrast") === "1");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [reasoningOverrides, setReasoningOverrides] = useState<ReasoningOverrides>({});
  const [threadMetadata, setThreadMetadata] = useState<Record<string, ThreadMetadataResult>>({});
  const [threadMetadataErrors, setThreadMetadataErrors] = useState<Record<string, string>>({});
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [threadActions, setThreadActions] = useState<Record<string, ThreadActionState | undefined>>({});
  const [planSnapshots, setPlanSnapshots] = useState<Record<string, PlanSnapshot>>({});
  const eventSocketRef = useRef<WebSocket | null>(null);
  const threadListPromiseRef = useRef<Promise<boolean> | null>(null);
  const approvalsPromiseRef = useRef<Promise<void> | null>(null);
  const modelsPromiseRef = useRef<Promise<void> | null>(null);
  const selectedRefreshRef = useRef<{ threadId: string; promise: Promise<void>; controller: AbortController } | null>(null);
  const olderRequestControllerRef = useRef<AbortController | null>(null);
  const threadMetadataRequestsRef = useRef(new Map<string, Promise<void>>());
  const threadMetadataFetchedRef = useRef(new Set<string>());
  const selectedIdRef = useRef(selectedId);
  const realtimeThreadIdRef = useRef<string | null>(null);
  const viewRef = useRef(view);
  const eventBufferRef = useRef<RpcNotification[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;
  realtimeThreadIdRef.current = realtimeThreadId(view, selectedId);
  viewRef.current = view;

  const resetThreadMetadata = () => {
    threadMetadataRequestsRef.current.clear();
    threadMetadataFetchedRef.current.clear();
    setThreadMetadata({});
    setThreadMetadataErrors({});
  };

  // Keep parameter reads isolated from the regular turns-only detail request.
  // A task is read at most once per signed-in mobile session, even if its
  // settings panel is opened repeatedly.
  const loadThreadMetadata = (threadId: string): Promise<void> => {
    if (threadMetadataFetchedRef.current.has(threadId)) return Promise.resolve();
    const existing = threadMetadataRequestsRef.current.get(threadId);
    if (existing) return existing;
    setThreadMetadataErrors(current => {
      if (!Object.prototype.hasOwnProperty.call(current, threadId)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    const request = api<ThreadMetadataResult>(`/api/threads/${encodeURIComponent(threadId)}/metadata`).then(result => {
      if (result.id !== threadId) throw new Error("任务参数响应不匹配");
      threadMetadataFetchedRef.current.add(threadId);
      setThreadMetadata(current => ({ ...current, [threadId]: result }));
    }).catch(cause => {
      threadMetadataFetchedRef.current.delete(threadId);
      setThreadMetadataErrors(current => ({ ...current, [threadId]: metadataReadErrorText(cause) }));
    }).finally(() => {
      if (threadMetadataRequestsRef.current.get(threadId) === request) threadMetadataRequestsRef.current.delete(threadId);
    });
    threadMetadataRequestsRef.current.set(threadId, request);
    return request;
  };

  useEffect(() => {
    const expired = () => {
      authGeneration++;
      clearClientCaches(window.localStorage);
      setAuth("signedOut");
      setSession(null);
      setThreads([]);
      eventBufferRef.current = [];
      setEvents([]);
      setDrafts({});
      setModelOverrides({});
      setReasoningOverrides({});
      resetThreadMetadata();
      setPlanSnapshots({});
      setSelectedId(null);
      window.history.replaceState(null, "", window.location.href);
      setError("登录已过期，请重新输入配对密钥");
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);

  useEffect(() => {
    const update = () => setPageVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (view === "live") setEvents(eventBufferRef.current);
  }, [view]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const keyboardOpen = window.innerHeight - viewport.height > 150;
      document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
      document.documentElement.style.setProperty("--visual-viewport-height", `${Math.round(viewport.height)}px`);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
      document.documentElement.classList.remove("keyboard-open");
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  const toggleContrast = (enabled: boolean) => {
    setHighContrast(enabled);
    window.localStorage.setItem("codex-mobile-high-contrast", enabled ? "1" : "0");
  };

  const completeSignIn = (result: AuthSessionInfo) => {
    authGeneration++;
    setSession(result);
    const cached = readClientCache(window.localStorage, window.location.origin, CLIENT_BUILD, result.epoch);
    setThreads(cached?.threads ?? []);
    setDrafts(cached?.drafts ?? {});
    setModelOverrides(cached?.modelOverrides ?? {});
    setReasoningOverrides(cached?.reasoningOverrides ?? {});
    setModelsError(null);
    resetThreadMetadata();
    setError(null);
    setAuth("signedIn");
    setSyncingThreads(true);
    void api<{ appServer: InitializeResult }>("/api/health").then(health => setServer(health.appServer)).catch(() => undefined);
    void Promise.allSettled([loadThreads(), loadApprovals(), loadModels()]);
  };

  const signOut = async (): Promise<void> => {
    try {
      await api("/api/auth/session", { method: "DELETE" });
    } finally {
      authGeneration++;
      clearClientCaches(window.localStorage);
      window.history.replaceState(null, "", window.location.href);
      setSession(null);
      setThreads([]);
      eventBufferRef.current = [];
      setEvents([]);
      setDrafts({});
      setModelOverrides({});
      setReasoningOverrides({});
      setModelsError(null);
      resetThreadMetadata();
      setPlanSnapshots({});
      setSelectedId(null);
      setAuth("signedOut");
      setError(null);
    }
  };

  // 合并同一浏览器内的重复列表请求，避免实时事件和轮询同时挤压共享 app-server。
  const loadThreads = (): Promise<boolean> => {
    if (threadListPromiseRef.current) return threadListPromiseRef.current;
    const request = api<{ data: ThreadSummary[] }>("/api/threads").then(result => {
      setThreads(result.data);
      setSyncingThreads(false);
      setError(null);
      return true;
    }).catch(cause => {
      setSyncingThreads(false);
      setError(gatewayReadErrorText(cause));
      return false;
    }).finally(() => {
      if (threadListPromiseRef.current === request) threadListPromiseRef.current = null;
    });
    threadListPromiseRef.current = request;
    return request;
  };

  // 审批轮询同样只保留一个在途请求，断线重连时不会形成请求堆积。
  const loadApprovals = (): Promise<void> => {
    if (approvalsPromiseRef.current) return approvalsPromiseRef.current;
    const request = api<{ data: ApprovalRequest[] }>("/api/approvals").then(result => {
      setApprovals(result.data);
    }).catch(cause => {
      setError(gatewayReadErrorText(cause));
    }).finally(() => {
      if (approvalsPromiseRef.current === request) approvalsPromiseRef.current = null;
    });
    approvalsPromiseRef.current = request;
    return request;
  };

  const loadModels = (): Promise<void> => {
    if (modelsPromiseRef.current) return modelsPromiseRef.current;
    const request = api<ModelListResult>("/api/models").then(result => {
      setModels(result.data.filter(model => !model.hidden));
      setModelsError(null);
    }).catch(cause => {
      setModelsError(`模型列表读取失败：${gatewayReadErrorText(cause)}`);
    }).finally(() => {
      if (modelsPromiseRef.current === request) modelsPromiseRef.current = null;
    });
    modelsPromiseRef.current = request;
    return request;
  };

  // 所有重连、轮询和事件刷新共用同一个当前任务读取，避免弱网恢复时重复排队。
  const refreshSelected = (threadId = selectedIdRef.current, replace = false): Promise<void> => {
    if (!threadId) return Promise.resolve();
    const existing = selectedRefreshRef.current;
    if (existing?.threadId === threadId) return existing.promise;
    existing?.controller.abort();
    const controller = new AbortController();
    const request = api<ThreadPageResult>(`/api/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal }).then(result => {
      if (selectedIdRef.current !== threadId || result.thread.id !== threadId) return;
      setSelected(current => replace ? result : mergeThreadPage(current, result));
    }).catch(cause => {
      if (!isAbortError(cause)) setError(gatewayReadErrorText(cause));
    }).finally(() => {
      if (selectedRefreshRef.current?.promise === request) selectedRefreshRef.current = null;
    });
    selectedRefreshRef.current = { threadId, promise: request, controller };
    return request;
  };

  useEffect(() => {
    let active = true;
    void api<AuthSessionInfo>("/api/auth/session").then(result => {
      if (!active) return;
      authGeneration++;
      setSession(result);
      const cached = readClientCache(window.localStorage, window.location.origin, CLIENT_BUILD, result.epoch);
      if (cached) {
        setThreads(cached.threads);
        setDrafts(cached.drafts);
        setModelOverrides(cached.modelOverrides);
        setReasoningOverrides(cached.reasoningOverrides);
      }
      setAuth("signedIn");
      setSyncingThreads(true);
      setError(null);
      void api<{ appServer: InitializeResult }>("/api/health").then(health => { if (active) setServer(health.appServer); }).catch(() => undefined);
      void Promise.allSettled([loadThreads(), loadApprovals(), loadModels()]);
    }).catch(cause => {
      if (!active) return;
      clearClientCaches(window.localStorage);
      setAuth("signedOut");
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/401|unauthorized/i.test(message) ? null : gatewayReadErrorText(cause));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (auth !== "signedIn" || !selectedId) {
      selectedRefreshRef.current?.controller.abort();
      selectedRefreshRef.current = null;
      olderRequestControllerRef.current?.abort();
      olderRequestControllerRef.current = null;
      setSelected(null);
      return;
    }
    setSelected(null);
    void refreshSelected(selectedId, true);
    return () => {
      if (selectedRefreshRef.current?.threadId === selectedId) selectedRefreshRef.current.controller.abort();
      olderRequestControllerRef.current?.abort();
    };
  }, [auth, selectedId]);

  useEffect(() => {
    if (auth !== "signedIn") return;
    const interval = pollIntervalMs({ visibility: pageVisibility, realtimeState });
    if (interval == null) return;
    const timer = window.setInterval(() => {
      void loadThreads();
      void loadApprovals();
      void refreshSelected();
    }, interval);
    return () => window.clearInterval(timer);
  }, [auth, selectedId, realtimeState, pageVisibility]);

  useEffect(() => {
    if (auth !== "signedIn" || !session) return;
    const timer = window.setTimeout(() => {
      writeClientCache(window.localStorage, window.location.origin, CLIENT_BUILD, session, threads, drafts, modelOverrides, reasoningOverrides, selectedId);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [auth, session, threads, drafts, modelOverrides, reasoningOverrides, selectedId]);

  const openThread = (id: string) => {
    if (mobileHistoryEnabled()) {
      const state = { codexMobileThreadId: id };
      if (selectedIdRef.current) window.history.replaceState(state, "", window.location.href);
      else window.history.pushState(state, "", window.location.href);
    }
    setSelectedId(id);
    window.scrollTo({ top: 0 });
  };

  const closeThread = () => {
    if (mobileHistoryEnabled() && typeof objectValue(window.history.state)?.codexMobileThreadId === "string") {
      window.history.back();
      return;
    }
    setSelectedId(null);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const threadId = objectValue(event.state)?.codexMobileThreadId;
      setView("threads");
      setSelectedId(typeof threadId === "string" ? threadId : null);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadOlderTurns = async (threadId: string, cursor: string): Promise<void> => {
    olderRequestControllerRef.current?.abort();
    const controller = new AbortController();
    olderRequestControllerRef.current = controller;
    try {
      const result = await api<ThreadPageResult>(`/api/threads/${encodeURIComponent(threadId)}?cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (selectedIdRef.current === threadId && result.thread.id === threadId) setSelected(current => mergeThreadPage(current, result));
    } finally {
      if (olderRequestControllerRef.current === controller) olderRequestControllerRef.current = null;
    }
  };

  // 草稿按任务保存；用户切换任务后仍能继续编辑，并在重新输入时清除旧错误。
  const updateDraft = (threadId: string, text: string) => {
    setDrafts(current => ({ ...current, [threadId]: text }));
    setThreadActions(current => {
      const action = current[threadId];
      if ((!action?.error && !action?.notice) || action.busy) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  };

  const updateModelOverride = (threadId: string, model: string | null) => {
    setModelOverrides(current => model === null ? clearThreadOverride(current, threadId) : { ...current, [threadId]: model });
    setReasoningOverrides(current => {
      if (model === null || !Object.prototype.hasOwnProperty.call(current, threadId)) return current;
      const options = reasoningOptions(models, model);
      const selected = current[threadId];
      if (options.some(option => option.reasoningEffort === selected)) return current;
      return clearThreadOverride(current, threadId);
    });
  };

  const updateReasoningOverride = (threadId: string, effort: string | null) => {
    setReasoningOverrides(current => effort === null ? clearThreadOverride(current, threadId) : { ...current, [threadId]: effort });
  };

  const sendMessage = async (threadId: string, text: string, activeTurnId: string | null): Promise<void> => {
    const message = text.trim();
    if (!message) return;
    const previous = threadActions[threadId];
    const requestId = previous?.kind === "send" && previous.error && previous.message === message && previous.requestId
      ? previous.requestId
      : createRequestId();
    setError(null);
    setThreadActions(current => ({ ...current, [threadId]: { kind: "send", busy: true, error: null, requestId, message } }));
    try {
      const receipt = await api<WriteReceiptResponse>(`/api/threads/${encodeURIComponent(threadId)}/turns`, {
        method: "POST",
        body: JSON.stringify({
          text: message,
          activeTurnId,
          requestId,
          ...(!activeTurnId && Object.prototype.hasOwnProperty.call(modelOverrides, threadId) ? { model: modelOverrides[threadId] } : {}),
          ...(!activeTurnId && Object.prototype.hasOwnProperty.call(reasoningOverrides, threadId) ? { reasoningEffort: reasoningOverrides[threadId] } : {})
        })
      });
      setDrafts(current => current[threadId]?.trim() === message ? { ...current, [threadId]: "" } : current);
      // `turn/start` persists explicit settings for later turns. Once the
      // server accepted them, discard the device-only staging values so a
      // later desktop-side change remains the source of truth.
      if (!activeTurnId) {
        setModelOverrides(current => clearThreadOverride(current, threadId));
        setReasoningOverrides(current => clearThreadOverride(current, threadId));
      }
      const notice = receipt.mode === "steer" ? "已提交到运行中的任务" : "已提交，任务已经开始";
      setThreadActions(current => ({ ...current, [threadId]: { kind: "send", busy: false, error: null, notice, requestId, message } }));
      window.setTimeout(() => setThreadActions(current => {
        if (current[threadId]?.requestId !== requestId || current[threadId]?.busy || current[threadId]?.error) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      }), 5_000);
      void loadThreads();
      void refreshSelected(threadId);
    } catch (cause) {
      setThreadActions(current => ({ ...current, [threadId]: { kind: "send", busy: false, error: sendErrorText(cause), requestId, message } }));
    }
  };

  const interruptTurn = async (threadId: string, turnId: string): Promise<void> => {
    setError(null);
    setThreadActions(current => ({ ...current, [threadId]: { kind: "interrupt", busy: true, error: null } }));
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`, { method: "POST" });
      setThreadActions(current => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      void loadThreads();
    } catch (cause) {
      setThreadActions(current => ({ ...current, [threadId]: { kind: "interrupt", busy: false, error: interruptErrorText(cause) } }));
    }
  };

  const decideApproval = async (requestId: string | number, decision: "accept" | "decline"): Promise<void> => {
    setError(null);
    await api(`/api/approvals/${encodeURIComponent(String(requestId))}`, { method: "POST", body: JSON.stringify({ decision }) });
    await loadApprovals();
  };

  useEffect(() => {
    if (auth !== "signedIn") {
      setRealtimeState("offline");
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let listRefreshTimer: number | undefined;
    let resumeTimer: number | undefined;
    let lastFrameAt = Date.now();
    const subscribe = () => {
      const threadId = realtimeThreadIdRef.current;
      if (threadId && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId } }));
      }
    };
    const resyncState = () => {
      subscribe();
      void Promise.allSettled([
        api<AuthSessionInfo>("/api/auth/session").then(result => setSession(result)),
        loadThreads(),
        loadApprovals(),
        refreshSelected()
      ]).then(() => {
        reportClientDiagnostic("info", "ws.resync_complete", { selectedThread: Boolean(selectedIdRef.current) });
      });
    };
    const scheduleReconnect = () => {
      if (!active || reconnectTimer != null) return;
      setRealtimeState(navigator.onLine ? "reconnecting" : "offline");
      const ceiling = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
      const delay = Math.floor(Math.random() * ceiling);
      reconnectAttempt++;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (!active || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      setRealtimeState(navigator.onLine ? "reconnecting" : "offline");
      lastFrameAt = Date.now();
      const next = new WebSocket(`${protocol}//${window.location.host}/api/events`);
      socket = next;
      eventSocketRef.current = next;
      reportClientDiagnostic("info", "ws.connecting", { attempt: reconnectAttempt, selectedThread: Boolean(selectedIdRef.current) });
      next.addEventListener("open", () => {
        if (!active || socket !== next) return;
        reconnectAttempt = 0;
        setRealtimeState("open");
        reportClientDiagnostic("info", "ws.open", { selectedThread: Boolean(selectedIdRef.current) });
        resyncState();
      });
      next.addEventListener("message", message => {
        if (!active || socket !== next) return;
        lastFrameAt = Date.now();
        try {
          const notification = JSON.parse(message.data) as RpcNotification;
          const selectedId = selectedIdRef.current;
          if (notification.method !== "connection/heartbeat") {
            eventBufferRef.current = [notification, ...eventBufferRef.current].slice(0, 80);
            if (eventFlushTimerRef.current == null) {
              eventFlushTimerRef.current = window.setTimeout(() => {
                eventFlushTimerRef.current = null;
                if (viewRef.current === "live") setEvents(eventBufferRef.current);
              }, EVENT_FLUSH_MS);
            }
          }
          const updatedPlan = planNotification(notification);
          if (updatedPlan && updatedPlan.threadId === selectedIdRef.current) setPlanSnapshots(current => ({ ...current, [planSnapshotKey(updatedPlan.threadId, updatedPlan.turnId)]: updatedPlan }));
          if (notification.method === "thread/snapshot") {
            setRealtimeState("open");
            const snapshot = objectValue(notification.params);
            const thread = objectValue(snapshot?.thread);
            if (selectedId && thread?.id === selectedId) setSelected(current => mergeThreadPage(current, snapshot as unknown as ThreadPageResult));
          }
          if (notification.method === "thread/snapshotError") {
            setRealtimeState("polling");
            reportClientDiagnostic("error", "ws.snapshot_error", { selectedThread: Boolean(selectedId) });
          }
          if (notification.method === "connection/heartbeat") {
            const state = objectValue(notification.params)?.upstreamState;
            setRealtimeState(state === "open" ? "open" : "polling");
          }
          if (notification.method === "connection/ready" || notification.method === "connection/upstream") {
            const state = objectValue(notification.params)?.state ?? objectValue(notification.params)?.upstreamState;
            setRealtimeState(state === "open" ? "open" : "polling");
            if (state === "open") resyncState();
            else void loadApprovals();
          }
          if (notification.method.startsWith("thread/") || notification.method.startsWith("turn/")) {
            window.clearTimeout(listRefreshTimer);
            listRefreshTimer = window.setTimeout(() => void loadThreads(), 250);
          }
          if (notification.method === "connection/serverRequest" || notification.method === "serverRequest/resolved" || notification.method === "approval/resolved") {
            void loadApprovals();
          }
        } catch (cause) {
          reportClientDiagnostic("error", "ws.invalid_message", { errorName: cause instanceof Error ? cause.name : "unknown" });
        }
      });
      next.addEventListener("error", () => {
        if (!active || socket !== next) return;
        reportClientDiagnostic("error", "ws.error", { readyState: next.readyState, selectedThread: Boolean(selectedIdRef.current) });
      });
      next.addEventListener("close", event => {
        if (socket !== next) return;
        socket = null;
        eventSocketRef.current = null;
        if (!active) return;
        reportClientDiagnostic("warn", "ws.closed", { code: event.code, reason: event.reason, selectedThread: Boolean(selectedIdRef.current) });
        if (event.code === 1008) {
          window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
          return;
        }
        scheduleReconnect();
      });
    };
    const reconnectNow = () => {
      const previous = socket;
      socket = null;
      eventSocketRef.current = null;
      reconnectAttempt = 0;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      lastFrameAt = Date.now();
      previous?.close(4001, "foreground resume");
      connect();
    };
    const resumeConnection = () => {
      if (!active) return;
      const decision = resumeDecision({
        lastFrameAgeMs: Date.now() - lastFrameAt,
        readyState: eventSocketRef.current?.readyState ?? null,
        visibility: document.visibilityState
      });
      if (decision === "idle") return;
      if (decision === "resync") {
        resyncState();
        return;
      }
      reconnectNow();
    };
    const scheduleResume = () => {
      if (!active || document.visibilityState === "hidden") return;
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(resumeConnection, 300);
    };
    const onVisibilityChange = () => scheduleResume();
    window.addEventListener("online", scheduleResume);
    window.addEventListener("pageshow", scheduleResume);
    document.addEventListener("visibilitychange", onVisibilityChange);
    connect();
    const snapshotMonitor = window.setInterval(() => {
      if (!active) return;
      if (document.visibilityState === "hidden") return;
      const frameAgeMs = Date.now() - lastFrameAt;
      if (socket && frameAgeMs > 30_000) {
        reportClientDiagnostic("warn", "ws.frame_stale", { ageMs: frameAgeMs, readyState: socket.readyState });
        reconnectNow();
      }
    }, 3000);
    return () => {
      active = false;
      window.removeEventListener("online", scheduleResume);
      window.removeEventListener("pageshow", scheduleResume);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(listRefreshTimer);
      window.clearTimeout(resumeTimer);
      window.clearInterval(snapshotMonitor);
      eventSocketRef.current = null;
      socket?.close();
      if (eventFlushTimerRef.current != null) window.clearTimeout(eventFlushTimerRef.current);
      eventFlushTimerRef.current = null;
    };
  }, [auth]);

  useEffect(() => {
    const socket = eventSocketRef.current;
    if (auth !== "signedIn" || socket?.readyState !== WebSocket.OPEN) return;
    const threadId = realtimeThreadId(view, selectedId);
    if (threadId) {
      socket.send(JSON.stringify({ method: "thread/subscribe", params: { threadId } }));
    } else {
      socket.send(JSON.stringify({ method: "thread/unsubscribe", params: {} }));
    }
  }, [auth, selectedId, view]);

  if (auth === "checking") return <div className="splash"><RadioTower size={22} /><span>正在连接</span></div>;
  if (auth === "signedOut") return <Login notice={error} onSignedIn={completeSignIn} />;

  return (
    <div className={`app-shell ${highContrast ? "high-contrast" : ""}`}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">›_</span><div><strong>Codex</strong><span>Mobile Console</span></div></div>
        <div className="topbar-actions">
          <span className="connection"><span className={`status-dot ${realtimeState === "open" ? "online" : realtimeState}`} />{realtimeStateText(realtimeState)}</span>
          <button className="icon-button" title="刷新任务" aria-label="刷新任务" onClick={() => { setSyncingThreads(true); void loadThreads(); }}><RefreshCw className={syncingThreads ? "spin" : undefined} size={18} /></button>
        </div>
      </header>
      <div className="read-only-strip"><ShieldCheck size={14} /><span>共享控制已启用</span><span className="strip-detail">兼容性验证已通过</span></div>
      <main className="main-layout">
        <aside className="sidebar">
          <nav className="nav-list" aria-label="主导航">
            <NavButton icon={<LayoutList size={18} />} label="任务" active={view === "threads"} onClick={() => { setView("threads"); closeThread(); }} count={threads.length} />
            <NavButton icon={<RadioTower size={18} />} label="实时" active={view === "live"} onClick={() => setView("live")} count={events.length} />
            <NavButton icon={<Settings2 size={18} />} label="设置" active={view === "settings"} onClick={() => setView("settings")} />
          </nav>
          <div className="sidebar-footer"><span className="platform-chip"><Circle size={8} fill="currentColor" />Windows gateway</span></div>
        </aside>
        <section className="content">
          <ApprovalPanel approvals={approvals} threads={threads} onDecision={decideApproval} />
            {view === "threads" && <ThreadsView threads={threads} models={models} modelsError={modelsError} modelOverrides={modelOverrides} reasoningOverrides={reasoningOverrides} threadMetadata={threadMetadata} threadMetadataErrors={threadMetadataErrors} planSnapshots={planSnapshots} syncing={syncingThreads} selectedId={selectedId} selected={selected} drafts={drafts} threadActions={threadActions} onSelect={openThread} onBack={closeThread} onLoadOlder={loadOlderTurns} onLoadMetadata={loadThreadMetadata} onDraftChange={updateDraft} onModelChange={updateModelOverride} onReasoningChange={updateReasoningOverride} onSend={sendMessage} onInterrupt={interruptTurn} />}
           {view === "live" && <LiveView events={events} state={realtimeState} />}
          {view === "settings" && <SettingsView server={server} highContrast={highContrast} onToggleContrast={toggleContrast} onSignOut={signOut} />}
          {error && <div className="error-banner"><WifiOff size={16} />{error}</div>}
        </section>
      </main>
    </div>
  );
}

function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: (session: AuthSessionInfo) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api<AuthSessionInfo>("/api/auth/session", { method: "POST", body: JSON.stringify({ token }) });
      setToken("");
      onSignedIn(session);
    } catch (cause) {
      setError(loginErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-shell"><div className="login-panel"><div className="login-logo">›_</div><p className="eyebrow">CODEX MOBILE CONSOLE</p><h1>连接 Windows 网关</h1><p className="muted">输入一次性配对凭据，凭据不会保存在此设备。</p>{notice && <p className="form-notice">{notice}</p>}<form onSubmit={submit}><label htmlFor="token">配对凭据</label><input id="token" type="password" autoComplete="one-time-code" value={token} onChange={event => setToken(event.target.value)} required disabled={busy} /><button className="primary-button" type="submit" disabled={busy || !token}>{busy ? <LoaderCircle className="spin" size={17} /> : <ChevronRight size={17} />}{busy ? "正在连接" : "建立连接"}</button></form>{error && <p className="form-error">{error}</p>}</div></div>;
}

function NavButton({ icon, label, active, count, onClick }: { icon: React.ReactNode; label: string; active: boolean; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span>{count != null && <em>{count}</em>}</button>;
}

function ThreadsView({ threads, models, modelsError, modelOverrides, reasoningOverrides, threadMetadata, threadMetadataErrors, planSnapshots, syncing, selectedId, selected, drafts, threadActions, onSelect, onBack, onLoadOlder, onLoadMetadata, onDraftChange, onModelChange, onReasoningChange, onSend, onInterrupt }: { threads: ThreadSummary[]; models: ModelSummary[]; modelsError: string | null; modelOverrides: Record<string, string>; reasoningOverrides: ReasoningOverrides; threadMetadata: Record<string, ThreadMetadataResult>; threadMetadataErrors: Record<string, string>; planSnapshots: Record<string, PlanSnapshot>; syncing: boolean; selectedId: string | null; selected: ThreadPageResult | null; drafts: Record<string, string>; threadActions: Record<string, ThreadActionState | undefined>; onSelect: (id: string) => void; onBack: () => void; onLoadOlder: (threadId: string, cursor: string) => Promise<void>; onLoadMetadata: (threadId: string) => Promise<void>; onDraftChange: (threadId: string, text: string) => void; onModelChange: (threadId: string, model: string | null) => void; onReasoningChange: (threadId: string, effort: string | null) => void; onSend: (threadId: string, text: string, activeTurnId: string | null) => Promise<void>; onInterrupt: (threadId: string, turnId: string) => Promise<void>; }) {
  const groups = groupThreads(threads);
  const current = selectedId && selected?.thread.id === selectedId ? selected : null;
  const summary = selectedId ? threads.find(thread => thread.id === selectedId) : undefined;
  return <div className={`threads-layout ${selectedId ? "has-selection" : ""}`}>
    <section className="thread-list">
      <div className="section-heading"><div><p className="eyebrow">工作区</p><h1>任务</h1></div><span className={`count-label sync-label ${syncing ? "syncing" : ""}`}>{syncing && <LoaderCircle className="spin" size={13} />}{threads.length} 项{syncing ? " · 正在同步" : ""}</span></div>
      <div className="thread-groups">{groups.map(group => <section className="thread-group" key={group.name}>
        <div className="thread-group-heading"><FolderClosed size={15} /><strong>{group.name}</strong><span>{group.threads.length}</span></div>
        <div className="thread-items">{group.threads.map(thread => {
          const action = threadActions[thread.id];
          const actionClass = action?.error ? "failed" : action?.busy ? "running" : action?.notice ? "done" : statusClass(thread.status);
          const actionText = action?.busy ? (action.kind === "interrupt" ? "正在停止" : "发送中") : action?.error ? (action.kind === "interrupt" ? "停止失败" : "发送失败") : action?.notice ? "已提交" : statusText(thread.status);
          return <button className={`thread-row ${thread.id === selectedId ? "selected" : ""}`} key={thread.id} title={action?.error || thread.cwd || undefined} aria-label={`${thread.name || thread.title || "未命名任务"}，${actionText}`} onClick={() => onSelect(thread.id)}>
            <span className={`status-dot ${actionClass}`} />
            <span className="thread-copy"><strong>{thread.name || thread.title || "未命名任务"}</strong><small>{threadListMeta(thread, Boolean(drafts[thread.id]?.trim()))}</small></span>
            <span className={`thread-status ${actionClass}`}>{actionText}</span><ChevronRight size={16} />
          </button>;
        })}</div>
      </section>)}</div>
    </section>
    <section className="thread-detail">{selectedId ? current ? <ThreadDetail read={current} summary={summary} metadata={threadMetadata[selectedId]} metadataError={threadMetadataErrors[selectedId]} models={models} modelsError={modelsError} modelOverride={modelOverrides[selectedId]} reasoningOverride={reasoningOverrides[selectedId]} planSnapshots={planSnapshots} draft={drafts[selectedId] || ""} action={threadActions[selectedId]} onBack={onBack} onLoadOlder={onLoadOlder} onLoadMetadata={onLoadMetadata} onDraftChange={text => onDraftChange(selectedId, text)} onModelChange={model => onModelChange(selectedId, model)} onReasoningChange={effort => onReasoningChange(selectedId, effort)} onSend={onSend} onInterrupt={onInterrupt} /> : <div className="empty-state"><Clock3 size={28} /><p>正在加载聊天记录</p></div> : <div className="empty-state"><LayoutList size={28} /><p>选择一个任务</p></div>}</section>
  </div>;
}

function ThreadDetail({ read, summary, metadata, metadataError, models, modelsError, modelOverride, reasoningOverride, planSnapshots, draft, action, onBack, onLoadOlder, onLoadMetadata, onDraftChange, onModelChange, onReasoningChange, onSend, onInterrupt }: { read: ThreadPageResult; summary?: ThreadSummary | undefined; metadata?: ThreadMetadataResult | undefined; metadataError?: string | undefined; models: ModelSummary[]; modelsError: string | null; modelOverride: string | undefined; reasoningOverride: string | undefined; planSnapshots: Record<string, PlanSnapshot>; draft: string; action: ThreadActionState | undefined; onBack: () => void; onLoadOlder: (threadId: string, cursor: string) => Promise<void>; onLoadMetadata: (threadId: string) => Promise<void>; onDraftChange: (text: string) => void; onModelChange: (model: string | null) => void; onReasoningChange: (effort: string | null) => void; onSend: (threadId: string, text: string, activeTurnId: string | null) => Promise<void>; onInterrupt: (threadId: string, turnId: string) => Promise<void> }) {
  const { thread, history } = read;
  const displayThread = mergeThreadMetadata(mergeThreadSummary(thread, summary), metadata);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const activeTurnId = activeTurn(turns);
  const needsResume = statusValue(displayThread.status) === "notLoaded";
  const outputVersion = latestOutputVersion(turns);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    const updateFollow = () => {
      followOutput.current = document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 180;
    };
    window.addEventListener("scroll", updateFollow, { passive: true });
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    return () => window.removeEventListener("scroll", updateFollow);
  }, [thread.id]);
  useEffect(() => {
    const focused = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest(".message-composer");
    if (followOutput.current && !focused) requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
  }, [outputVersion]);
  const loadOlder = async () => {
    if (!history.hasOlder || !history.olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      await onLoadOlder(thread.id, history.olderCursor);
    } catch (cause) {
      setHistoryError(`读取更早记录失败：${gatewayReadErrorText(cause)}`);
    } finally {
      setLoadingOlder(false);
    }
  };
  const turnViews = turns.map((turn, index) => {
    const turnId = objectValue(turn)?.id;
    const livePlan = typeof turnId === "string" ? planSnapshots[planSnapshotKey(thread.id, turnId)] : undefined;
    return livePlan && typeof turnId === "string" ? <Turn key={turnId} turn={turn} index={index} plan={livePlan} /> : <Turn key={typeof turnId === "string" ? turnId : index} turn={turn} index={index} />;
  });
  return <><button className="detail-back" onClick={onBack}><ArrowLeft size={18} /><span>返回任务</span></button><div className="detail-heading"><div><p className="eyebrow">任务</p><h2>{displayThread.name || displayThread.title || "未命名任务"}</h2><span className="detail-meta"><Clock3 size={14} />{displayThread.cwd || "本地工作区"}</span></div><div className="detail-state"><span className="model-summary"><Brain size={14} />{modelLabel(models, modelOverride, displayThread)}</span><span className="reasoning-summary"><Gauge size={14} />{reasoningLabel(models, modelOverride, reasoningOverride, displayThread)}</span><span className={`state-pill ${statusClass(displayThread.status)}`}>{statusText(displayThread.status)}</span></div></div><div className="turn-list">{history.hasOlder && <button className="history-button" type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={16} />}<span>加载更早记录</span><small>已显示 {turns.length} 轮</small></button>}{historyError && <p className="history-error" role="alert"><CircleAlert size={14} />{historyError}</p>}{turns.length === 0 ? <div className="empty-state compact"><Clock3 size={24} /><p>暂无可见历史</p></div> : turnViews}</div><MessageComposer text={draft} action={action} models={models} modelsError={modelsError} thread={displayThread} metadataError={metadataError} modelOverride={modelOverride} reasoningOverride={reasoningOverride} activeTurnId={activeTurnId} needsResume={needsResume} onOpenSettings={() => onLoadMetadata(thread.id)} onModelChange={onModelChange} onReasoningChange={onReasoningChange} onTextChange={onDraftChange} onSend={text => onSend(thread.id, text, activeTurnId)} onInterrupt={activeTurnId ? () => onInterrupt(thread.id, activeTurnId) : undefined} /><div className="chat-bottom" ref={bottomRef} /></>;
}

function MessageComposer({ text, action, models, modelsError, thread, metadataError, modelOverride, reasoningOverride, activeTurnId, needsResume, onOpenSettings, onModelChange, onReasoningChange, onTextChange, onSend, onInterrupt }: { text: string; action: ThreadActionState | undefined; models: ModelSummary[]; modelsError: string | null; thread: ThreadSummary; metadataError: string | undefined; modelOverride: string | undefined; reasoningOverride: string | undefined; activeTurnId: string | null; needsResume: boolean; onOpenSettings: () => void; onModelChange: (model: string | null) => void; onReasoningChange: (effort: string | null) => void; onTextChange: (text: string) => void; onSend: (text: string) => Promise<void>; onInterrupt: (() => Promise<void>) | undefined }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(action?.busy);
  const actionError = action?.error || null;
  const actionNotice = action?.notice || null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    await onSend(message);
  };
  const interrupt = async () => {
    if (!onInterrupt || busy) return;
    await onInterrupt();
  };
  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const scrollY = window.scrollY;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    // iOS may scroll the document when a fixed composer changes height. Keep
    // the user's reading position stable while typing.
    if (document.activeElement === textarea && Math.abs(window.scrollY - scrollY) > 1) window.scrollTo({ top: scrollY, behavior: "auto" });
  };
  const updateText = (value: string) => {
    onTextChange(value);
    requestAnimationFrame(resizeTextarea);
  };
  const feedback = busy ? (action?.kind === "interrupt" ? "正在停止任务" : needsResume ? "正在加载任务并发送" : activeTurnId ? "正在追加消息" : "正在发送") : actionError || actionNotice;
  const effortOptions = reasoningOptions(models, modelOverride, thread);
  useEffect(() => setSettingsOpen(false), [thread.id]);
  useEffect(() => {
    const frame = requestAnimationFrame(resizeTextarea);
    return () => cancelAnimationFrame(frame);
  }, [text, thread.id]);
  const toggleSettings = () => {
    if (!settingsOpen) onOpenSettings();
    setSettingsOpen(value => !value);
  };
  return <form className="message-composer" onSubmit={submit}>{feedback && <div className={`composer-feedback ${actionError ? "error" : actionNotice ? "success" : ""}`} role={actionError ? "alert" : "status"}>{actionError ? <CircleAlert size={15} /> : busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}<span>{feedback}</span></div>}<button className="composer-settings-toggle" type="button" aria-expanded={settingsOpen} onClick={toggleSettings}><Settings2 size={15} /><span>参数</span><small>{modelLabel(models, modelOverride, thread)} · {reasoningLabel(models, modelOverride, reasoningOverride, thread).replace("推理 · ", "")}</small><ChevronDown size={15} className={settingsOpen ? "open" : ""} /></button>{settingsOpen && <div className="composer-settings">{modelsError && <p className="composer-settings-error" role="alert"><CircleAlert size={15} /><span>{modelsError}</span></p>}{metadataError && <p className="composer-settings-error" role="alert"><CircleAlert size={15} /><span>{metadataError}</span></p>}<label className="composer-setting"><span><Brain size={15} />模型</span><select aria-label="模型" value={modelOverride ?? "__task__"} disabled={Boolean(activeTurnId) || busy || models.length === 0} onChange={event => onModelChange(event.target.value === "__task__" ? null : event.target.value)}><option value="__task__">{modelLabel(models, modelOverride, thread)}</option>{models.map(model => <option value={model.id} key={model.id}>{model.displayName}</option>)}</select></label><label className="composer-setting"><span><Gauge size={15} />推理强度</span><select aria-label="推理强度" value={reasoningOverride ?? "__task__"} disabled={Boolean(activeTurnId) || busy || effortOptions.length === 0} onChange={event => onReasoningChange(event.target.value === "__task__" ? null : event.target.value)}><option value="__task__">{reasoningTaskLabel(thread)}</option>{effortOptions.map(option => <option value={option.reasoningEffort} key={option.reasoningEffort}>{reasoningEffortLabel(option.reasoningEffort)}</option>)}</select></label>{activeTurnId && <small>任务运行中</small>}</div>}<textarea ref={textareaRef} aria-label="发送消息" placeholder={activeTurnId ? "向运行中的任务追加消息" : "发送消息"} value={text} onChange={event => updateText(event.target.value)} rows={1} /><div className="composer-actions">{onInterrupt && <button className="composer-button stop" type="button" title="停止任务" aria-label="停止任务" onClick={() => void interrupt()} disabled={busy}><Square size={17} fill="currentColor" /></button>}<button className="composer-button send" type="submit" title="发送消息" aria-label="发送消息" disabled={busy || !text.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}</button></div></form>;
}

function ApprovalPanel({ approvals, threads, onDecision }: { approvals: ApprovalRequest[]; threads: ThreadSummary[]; onDecision: (requestId: string | number, decision: "accept" | "decline") => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (approvals.length === 0) return null;
  const decide = async (approval: ApprovalRequest, decision: "accept" | "decline") => {
    const id = String(approval.id);
    setBusyId(id);
    setErrors(current => { const next = { ...current }; delete next[id]; return next; });
    try {
      await onDecision(approval.id, decision);
    } catch (cause) {
      setErrors(current => ({ ...current, [id]: `处理失败：${sendErrorText(cause)}` }));
    } finally {
      setBusyId(null);
    }
  };
  return <section className="approval-panel"><div className="approval-heading"><div><p className="eyebrow">操作确认</p><h2>待审批</h2></div><span className="count-label">{approvals.length} 项</span></div>{approvals.map(approval => { const thread = threads.find(item => item.id === approvalThreadId(approval)); const id = String(approval.id); const busy = busyId === id; return <article className="approval-item" key={id}><div className="approval-copy"><strong>{approvalTitle(approval.method)}</strong><span>{thread?.name || thread?.title || approvalThreadId(approval) || "当前任务"}</span><code>{approvalSummary(approval.params)}</code>{errors[id] && <span className="approval-error" role="alert"><CircleAlert size={14} />{errors[id]}</span>}</div><div className="approval-actions"><button className="approval-button accept" disabled={busy} onClick={() => void decide(approval, "accept")}><ShieldCheck size={16} />允许一次</button><button className="approval-button decline" disabled={busy} onClick={() => void decide(approval, "decline")}><ShieldX size={16} />拒绝</button></div></article>; })}</section>;
}

function Turn({ turn, index, plan: livePlan }: { turn: unknown; index: number; plan?: PlanSnapshot }) {
  const object = typeof turn === "object" && turn !== null ? turn as Record<string, unknown> : {};
  const items = Array.isArray(object.items) ? object.items : [];
  const state = statusClass(object.status);
  const status = statusValue(object.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);
  const startedAt = typeof object.startedAt === "number" || typeof object.startedAt === "string" ? object.startedAt : null;
  const completedAt = typeof object.completedAt === "number" || typeof object.completedAt === "string" ? object.completedAt : null;
  const duration = turnDurationMs(turn, now);
  const durationLabel = duration == null ? "耗时未知" : state === "running" && timestampMs(completedAt) == null ? `处理中 ${formatDurationMs(duration)}` : `耗时 ${formatDurationMs(duration)}`;
  const userTime = timestampMs(startedAt) == null ? null : formatConversationTime(startedAt, now);
  const assistantTime = timestampMs(completedAt) == null ? null : formatConversationTime(completedAt, now);
  const lastAssistantItem = items.findLast(item => itemRole(item) === "agent");
  const historyPlan = latestPlanFromTurn(turn);
  const plan = livePlan?.plan ?? historyPlan;
  const blocks = turnBlocks(plan ? items.filter(item => itemType(item) !== "plan") : items);
  const errorMessage = turnErrorText(turn);
  return <section className="turn"><div className={`turn-label ${state}`}><span>第 {index + 1} 轮</span><span>{formatConversationTime(startedAt, now)}</span><span>{durationLabel}</span>{(state === "failed" || ["interrupted", "cancelled"].includes(status)) && <span>{statusText(object.status)}</span>}</div>{errorMessage && <div className="turn-error" role="alert"><CircleAlert size={16} /><div><strong>任务失败原因</strong><span>{errorMessage}</span></div></div>}{plan && (livePlan?.explanation === undefined ? <PlanCard plan={plan} /> : <PlanCard plan={plan} explanation={livePlan.explanation} />)}<div className="turn-messages">{blocks.map((block, blockIndex) => block.kind === "activity" ? <ActivityGroup items={block.items} active={state === "running"} key={`activity-${itemId(block.items[0], blockIndex)}`} /> : <ThreadItem item={block.item} time={itemRole(block.item) === "user" ? userTime : block.item === lastAssistantItem ? assistantTime : null} key={itemId(block.item, blockIndex)} />)}</div></section>;
}

function PlanCard({ plan, explanation }: { plan: PlanStep[]; explanation?: string | null }) {
  const progress = planProgress(plan);
  return <section className="plan-card" aria-label={`执行计划，第 ${progress.currentStep} / ${progress.total} 步`}><div className="plan-card-heading"><ListChecks size={17} /><strong>执行计划</strong></div>{explanation && <p className="plan-explanation">{explanation}</p>}<ol className="plan-steps">{plan.map((step, index) => <li className={step.status} key={`${index}-${step.step}`}>{step.status === "completed" ? <CircleCheck aria-hidden="true" size={18} /> : step.status === "inProgress" ? <LoaderCircle className="spin" aria-hidden="true" size={18} /> : <Circle aria-hidden="true" size={18} />}<span>{step.step}</span></li>)}</ol><div className="plan-progress"><span>{progress.completed} 项已完成</span><strong>第 {progress.currentStep} / {progress.total} 步</strong></div></section>;
}

function ActivityGroup({ items, active }: { items: unknown[]; active: boolean }) {
  const itemStates = items.map(item => statusClass(itemRecord(item).status ?? itemRecord(item).state));
  const state = itemStates.includes("failed") ? "failed" : active || itemStates.includes("running") ? "running" : "done";
  const [open, setOpen] = useState(state === "running" || state === "failed");
  const detailId = `activity-${itemId(items[0], 0)}`;
  const labels = [...new Set(items.map(toolLabel))];
  const summary = `${labels.slice(0, 3).join("、")}${labels.length > 3 ? ` 等 ${labels.length} 类` : ""}`;
  useEffect(() => {
    if (state === "running" || state === "failed") setOpen(true);
  }, [state]);
  return <section className={`activity-group ${state} ${open ? "open" : "collapsed"}`}>
    <button className="activity-summary" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}>
      <span className="activity-icon" aria-hidden="true">{state === "running" ? <LoaderCircle className="spin" size={16} /> : state === "failed" ? <CircleAlert size={16} /> : <Wrench size={16} />}</span>
      <span className="activity-copy"><strong>执行过程</strong><small>{summary}</small></span>
      <span className="activity-count">{items.length} 项</span><ChevronDown className="tool-chevron" size={16} aria-hidden="true" />
    </button>
    {open && <div className="activity-items" id={detailId}>{items.map((item, index) => <ToolCard item={item} key={itemId(item, index)} />)}</div>}
  </section>;
}

function ThreadItem({ item, time = null }: { item: unknown; time?: string | null }) {
  const role = itemRole(item);
  if (role === "system") return <div className="system-row"><span>{toolLabel(item)}</span></div>;
  if (isConversationItem(item)) {
    return <div className={`message-row ${role}`}><span className="message-avatar">{role === "user" ? "我" : "C"}</span><div className="message-stack"><div className="message-bubble">{itemText(item) || "（空消息）"}</div>{time && <time className="message-time">{time}</time>}</div></div>;
  }
  return <ToolCard item={item} />;
}

function ToolCard({ item }: { item: unknown }) {
  const object = itemRecord(item);
  const type = itemType(item);
  const status = object.status ?? object.state;
  const state = statusClass(status);
  const statusLabel = statusValue(status) ? statusText(status) : null;
  const details = itemDetails(item);
  const [open, setOpen] = useState(state === "running" || state === "failed");
  const [showAll, setShowAll] = useState(false);
  const detailId = `item-details-${itemId(item, 0)}`;
  useEffect(() => {
    if (state === "failed") setOpen(true);
  }, [state]);
  const toggle = (button: HTMLButtonElement) => {
    const beforeTop = button.getBoundingClientRect().top;
    setOpen(value => !value);
    requestAnimationFrame(() => {
      const delta = button.getBoundingClientRect().top - beforeTop;
      if (delta) window.scrollBy({ top: delta, behavior: "auto" });
    });
  };
  const icon = type === "fileChange" ? <FilePenLine size={16} /> : type === "commandExecution" ? <Terminal size={16} /> : type === "reasoning" ? <Brain size={16} /> : type === "plan" ? <ListChecks size={16} /> : type === "webSearch" ? <Search size={16} /> : type === "imageView" || type === "imageGeneration" ? <Image size={16} /> : type === "unknown" ? <CircleAlert size={16} /> : <Wrench size={16} />;
  const visibleDetails = showAll ? details : details.slice(0, 12);
  return <article className={`tool-card ${state} ${open ? "open" : "collapsed"}`}>
    <button className={`tool-card-header ${statusLabel ? "has-status" : ""}`} type="button" aria-expanded={open} aria-controls={detailId} onClick={event => toggle(event.currentTarget)}>
      <span className="tool-icon" aria-hidden="true">{icon}</span>
      <span className="tool-card-copy"><strong>{toolLabel(item)}</strong><span>{itemSummary(item)}</span></span>
      {statusLabel && <span className="tool-card-status">{statusLabel}</span>}
      <ChevronDown className="tool-chevron" size={16} aria-hidden="true" />
    </button>
    {open && <div className="tool-card-details" id={detailId}>
      {visibleDetails.length > 0 ? <div className="tool-detail-lines">{visibleDetails.map((line, index) => <code key={`${itemId(item, 0)}-${index}`}>{line}</code>)}</div> : <span className="tool-empty">暂无详情</span>}
      {details.length > 12 && <button className="tool-more" type="button" onClick={() => setShowAll(value => !value)}>{showAll ? "收起详情" : `展开全部（${details.length} 行）`}</button>}
      {type === "unknown" && <code className="tool-raw-type">协议事件：{type}</code>}
    </div>}
  </article>;
}

function LiveView({ events, state }: { events: RpcNotification[]; state: RealtimeState }) {
  return <div className="live-view"><div className="section-heading"><div><p className="eyebrow">事件流</p><h1>实时</h1></div><span className="live-indicator"><Wifi size={15} />{realtimeStateText(state)}</span></div>{events.length === 0 ? <div className="empty-state"><RadioTower size={28} /><p>等待事件</p></div> : <div className="event-list">{events.map((event, index) => <div className="event-row" key={`${event.method}-${index}`}><span className="event-time">{eventTime(event)}</span><div><strong>{eventLabel(event.method)}</strong><small>{event.method}</small></div><code>{eventParamsPreview(event.params)}</code></div>)}</div>}</div>;
}

function SettingsView({ server, highContrast, onToggleContrast, onSignOut }: { server: InitializeResult | null; highContrast: boolean; onToggleContrast: (enabled: boolean) => void; onSignOut: () => Promise<void> }) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsStatus | null>(null);
  const [loadedTasks, setLoadedTasks] = useState<LoadedTasksDiagnosticsResult | null>(null);
  const [loadedTasksError, setLoadedTasksError] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = () => void api<DiagnosticsStatus>("/api/diagnostics/status").then(result => { if (active) setDiagnostics(result); }).catch(() => undefined);
    const schedule = () => {
      window.clearTimeout(timer);
      if (!active || document.visibilityState === "hidden") return;
      load();
      timer = window.setTimeout(schedule, 5_000);
    };
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = () => void api<LoadedTasksDiagnosticsResult>("/api/diagnostics/loaded-tasks").then(result => {
      if (!active) return;
      setLoadedTasks(result);
      setLoadedTasksError(false);
    }).catch(() => {
      if (active) {
        setLoadedTasks(null);
        setLoadedTasksError(true);
      }
    });
    const schedule = () => {
      window.clearTimeout(timer);
      if (!active || document.visibilityState === "hidden") return;
      load();
      timer = window.setTimeout(schedule, 30_000);
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, []);
  const health = stabilityHealth(diagnostics);
  const stability = diagnostics?.stability;
  return <div className="settings-view">
    <div className="section-heading"><div><p className="eyebrow">本地网关</p><h1>设置</h1></div></div>
    <div className="settings-subheading"><strong>最近 5 分钟</strong><span className={health.className}>{health.label}</span></div>
    <div className="settings-list stability-list">
      <div className="setting-row"><span>请求成功率</span><strong>{metricRate(stability?.upstream.successRate, stability?.upstream.requests)}</strong></div>
      <div className="setting-row"><span>请求延迟 P95 / P99</span><strong>{metricLatencyPair(stability?.upstream.p95Ms, stability?.upstream.p99Ms)}</strong></div>
      <div className="setting-row"><span>超时 / 重连</span><strong>{stability ? `${stability.upstream.timeouts} / ${stability.reconnects}` : "读取中"}</strong></div>
      <div className="setting-row"><span>快照成功率</span><strong>{metricRate(stability?.snapshots.successRate, stability?.snapshots.runs)}</strong></div>
    </div>
    <div className="settings-subheading"><strong>已加载任务</strong><span className={loadedTasksError ? "warning-text" : undefined}>{loadedTasksError ? "读取失败" : loadedTasks ? `${loadedTasks.total} 个` : "读取中"}</span></div>
    <div className="settings-list loaded-task-list">
      {loadedTasksError && !loadedTasks ? <div className="setting-row"><span>加载状态</span><strong className="warning-text">读取失败</strong></div> : loadedTasks && loadedTasks.data.length > 0 ? loadedTasks.data.map(task => <div className="setting-row loaded-task-row" key={task.id}><span className="loaded-task-name"><strong>{task.name || task.title || "未命名任务"}</strong><small>{projectFolder(task.cwd)}</small></span><span className="loaded-task-status"><strong>{statusText(task.status)}</strong><small className={task.gatewayHeld ? "success-text" : "warning-text"}>{task.gatewayHeld ? "手机网关持有" : "桌面端或其他连接"}</small></span></div>) : loadedTasks ? <div className="setting-row"><span>加载状态</span><strong>暂无</strong></div> : <div className="setting-row"><span>加载状态</span><strong>读取中</strong></div>}
    </div>
     <div className="settings-subheading"><strong>当前状态</strong><span>自适应刷新</span></div>
     <div className="settings-list">
       <div className="setting-row"><span>配置应用</span><strong className={diagnostics?.config?.state === "pending" ? "warning-text" : diagnostics?.config?.state === "applied" ? "success-text" : undefined}>{configStateText(diagnostics?.config?.state)}</strong></div>
       {diagnostics?.config?.state === "pending" && <div className="setting-row"><span>待应用指纹</span><code title={diagnostics.config.pendingFingerprint || undefined}>{shortFingerprint(diagnostics.config.pendingFingerprint)}</code></div>}
       {diagnostics?.config?.requestedAt && <div className="setting-row"><span>变更登记时间</span><strong>{diagnosticTime(diagnostics.config.requestedAt)}</strong></div>}
      <div className="setting-row"><span>连接状态</span><strong className="success-text">已认证</strong></div>
      <div className="setting-row"><span>上游连接</span><strong className={diagnostics?.upstream.state === "open" ? "success-text" : "warning-text"}>{upstreamStateText(diagnostics?.upstream.state)}</strong></div>
      <div className="setting-row"><span>上游在途请求</span><strong>{diagnostics ? `${diagnostics.upstream.pendingRequests} 个` : "读取中"}</strong></div>
      <div className="setting-row"><span>正在写入任务</span><strong>{diagnostics ? `${diagnostics.writes.activeThreads} 个` : "读取中"}</strong></div>
      <div className="setting-row"><span>实时订阅</span><strong>{diagnostics ? `${diagnostics.realtime.subscriptions} 个` : "读取中"}</strong></div>
       <div className="setting-row"><span>在途快照读取</span><strong>{diagnostics ? `${diagnostics.realtime.threadPagesInFlight} 个` : "读取中"}</strong></div>
       <div className="setting-row"><span>取消订阅失败</span><strong className={diagnostics?.unsubscribeFailures?.length ? "warning-text" : "success-text"}>{diagnostics ? `${diagnostics.unsubscribeFailures?.length ?? 0} 个` : "读取中"}</strong></div>
      <div className="setting-row"><span>最近快照</span><strong>{diagnosticTime(diagnostics?.realtime.lastSnapshotAt)}</strong></div>
      <div className="setting-row"><span>最近快照错误</span><strong className={diagnostics?.realtime.lastSnapshotErrorAt ? "warning-text" : "success-text"}>{diagnostics?.realtime.lastSnapshotErrorAt ? diagnosticTime(diagnostics.realtime.lastSnapshotErrorAt) : "无"}</strong></div>
      <div className="setting-row"><span>诊断日志</span><code>{diagnostics?.log.fileName || "gateway.ndjson"}</code></div>
      <div className="setting-row"><span>移动操作</span><strong className="success-text">发送、停止、审批</strong></div>
      <div className="setting-row"><span>户外高对比</span><label className="switch-control"><input type="checkbox" checked={highContrast} onChange={event => onToggleContrast(event.target.checked)} /><span className="switch-track" aria-hidden="true" /></label></div>
      <div className="setting-row"><span>界面版本</span><code>{CLIENT_BUILD}</code></div>
      <div className="setting-row"><span>运行平台</span><strong>{server?.platformOs || "Windows"}</strong></div>
      <div className="setting-row"><span>Codex Home</span><code>{server?.codexHome || "未返回"}</code></div>
      <div className="setting-row"><span>上游版本</span><code>{server?.userAgent || "未返回"}</code></div>
    </div>
    <button className="secondary-button" onClick={() => void onSignOut()}><LogOut size={16} />退出会话</button>
  </div>;
}

function activeTurn(turns: unknown[]): string | null { for (let index = turns.length - 1; index >= 0; index--) { const turn = objectValue(turns[index]); const status = statusValue(turn?.status); if (turn && ["inProgress", "active", "running", "started"].includes(status) && typeof turn.id === "string") return turn.id; } return null; }
function objectValue(value: unknown): JsonObject | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null; }
function notificationTargetsThread(notification: RpcNotification, threadId: string): boolean { const params = objectValue(notification.params); const message = objectValue(params?.message); return params?.threadId === threadId || objectValue(message?.params)?.threadId === threadId; }
function approvalThreadId(approval: ApprovalRequest): string | null { const value = approval.params.threadId ?? approval.params.conversationId; return typeof value === "string" ? value : null; }
function approvalTitle(method: string): string { return ({ "item/commandExecution/requestApproval": "命令执行请求", "item/fileChange/requestApproval": "文件修改请求", "item/permissions/requestApproval": "权限请求", execCommandApproval: "命令执行请求", applyPatchApproval: "文件修改请求" } as Record<string, string>)[method] || "操作请求"; }
function approvalSummary(params: JsonObject): string { if (typeof params.command === "string") return params.command; if (Array.isArray(params.command)) return params.command.join(" "); if (typeof params.reason === "string" && params.reason) return params.reason; if (params.permissions) return JSON.stringify(params.permissions); return "请在执行前确认此操作"; }
function latestOutputVersion(turns: unknown[]): string { const turn = objectValue(turns.at(-1)); const items = Array.isArray(turn?.items) ? turn.items : []; return `${String(turn?.id ?? "")}:${String(turn?.status ?? "")}:${items.map((item, index) => `${itemId(item, index)}:${itemType(item)}:${itemRecord(item).status ?? ""}:${itemText(item).length}:${itemDetails(item).join("\n").length}`).join("|")}`; }
function groupThreads(threads: ThreadSummary[]): Array<{ name: string; threads: ThreadSummary[] }> { const groups = new Map<string, ThreadSummary[]>(); for (const thread of threads) { const name = projectFolder(thread.cwd); const group = groups.get(name); if (group) group.push(thread); else groups.set(name, [thread]); } return [...groups].map(([name, groupedThreads]) => ({ name, threads: groupedThreads })); }
function projectFolder(cwd: string | null | undefined): string { if (!cwd) return "其他任务"; const parts = cwd.replaceAll("/", "\\").split("\\").filter(Boolean); const desktopIndex = parts.findIndex(part => part.toLowerCase() === "desktop"); return parts[desktopIndex >= 0 ? desktopIndex + 1 : parts.length - 1] || "其他任务"; }
function mobileHistoryEnabled(): boolean { return window.matchMedia("(max-width: 860px)").matches || window.matchMedia("(display-mode: standalone)").matches; }

// 将连续工具事件合并为一个执行过程，保留用户和助手消息的主要阅读节奏。
function turnBlocks(items: unknown[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let activity: unknown[] = [];
  const flush = () => {
    if (activity.length > 0) blocks.push({ kind: "activity", items: activity });
    activity = [];
  };
  for (const item of items) {
    if (itemRole(item) === "tool") {
      activity.push(item);
      continue;
    }
    flush();
    blocks.push({ kind: "item", item });
  }
  flush();
  return blocks;
}

// 列表已按项目分组，因此优先显示更新时间和未发送草稿，减少重复路径噪声。
function threadListMeta(thread: ThreadSummary, hasDraft: boolean): string {
  const parts = [relativeThreadTime(thread.updatedAt ?? thread.createdAt)];
  if (hasDraft) parts.push("有草稿");
  return parts.join(" · ");
}

function modelLabel(models: ModelSummary[], override: string | undefined, thread?: ThreadSummary): string {
  const selected = override ? models.find(model => model.id === override || model.model === override) : undefined;
  if (selected) return selected.displayName;
  if (typeof thread?.model === "string" && thread.model) {
    const current = models.find(model => model.id === thread.model || model.model === thread.model);
    return current?.displayName ?? thread.model;
  }
  return "跟随任务设置";
}

function reasoningOptions(models: ModelSummary[], modelOverride: string | undefined, thread?: ThreadSummary): ModelSummary["supportedReasoningEfforts"] {
  const model = modelOverride
    ? models.find(candidate => candidate.id === modelOverride || candidate.model === modelOverride)
    : thread?.model ? models.find(candidate => candidate.id === thread.model || candidate.model === thread.model) : undefined;
  return model?.supportedReasoningEfforts ?? [];
}

function reasoningTaskLabel(thread?: ThreadSummary): string {
  return thread?.reasoningEffort ? `跟随任务 · ${reasoningEffortLabel(thread.reasoningEffort)}` : "跟随任务设置";
}

function reasoningLabel(models: ModelSummary[], modelOverride: string | undefined, override: string | undefined, thread?: ThreadSummary): string {
  const effort = override || thread?.reasoningEffort;
  return effort ? `推理 · ${reasoningEffortLabel(effort)}` : `推理 · ${reasoningTaskLabel(thread)}`;
}

function reasoningEffortLabel(effort: string): string {
  return ({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "Ultra" } as Record<string, string>)[effort] ?? effort;
}

// 同时兼容 app-server 返回的 ISO 时间、毫秒时间戳和秒时间戳。
function relativeThreadTime(value: string | number | null | undefined): string {
  if (value == null) return "等待更新时间";
  const timestamp = typeof value === "number" ? (value < 1_000_000_000_000 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "更新时间未知";
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚更新";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function eventLabel(method: string): string { const value = method.split("/").at(-1) || method; return ({ ready: "连接就绪", snapshot: "任务快照", started: "任务开始", completed: "任务完成", update: "任务更新", request: "操作请求", resolved: "请求已处理" } as Record<string, string>)[value] || "实时事件"; }
function eventTime(event: RpcNotification): string { const params = objectValue(event.params); const timestamp = params?.timestamp ?? params?.createdAt ?? params?.time; const parsed = timestampMs(typeof timestamp === "number" || typeof timestamp === "string" ? timestamp : null); const date = parsed == null ? new Date() : new Date(parsed); return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function eventParamsPreview(params: unknown): string { if (params == null) return ""; try { const raw = JSON.stringify(params); return raw.length > 1_500 ? `${raw.slice(0, 1_500)}…` : raw; } catch { return "（事件参数无法显示）"; } }
function diagnosticRoute(path: string): string { return path.replace(/\/api\/threads\/[^/]+/g, "/api/threads/:threadId").replace(/\/turns\/[^/]+/g, "/turns/:turnId").replace(/\/api\/approvals\/[^/]+/g, "/api/approvals/:requestId"); }
function upstreamStateText(state: string | undefined): string { return ({ open: "正常", connecting: "连接中", reconnecting: "重连中", closed: "已断开" } as Record<string, string>)[state || ""] || "读取中"; }
function realtimeStateText(state: RealtimeState): string { return ({ open: "实时", reconnecting: "重连中", polling: "轮询中", offline: "离线" } as Record<RealtimeState, string>)[state]; }
function diagnosticTime(value: string | null | undefined): string { if (!value) return "等待数据"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间无效" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function configStateText(state: "pending" | "applied" | "unknown" | undefined): string { return ({ pending: "待维护窗口应用", applied: "已应用", unknown: "暂不可确认" } as Record<string, string>)[state || "unknown"] || "暂不可确认"; }
function shortFingerprint(value: string | null | undefined): string { if (!value) return "未返回"; return `${value.slice(0, 12)}…`; }

function gatewayReadErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/401|unauthorized/i.test(message)) return "网关已重启或登录已过期，请重新输入配对密钥";
  if (/network|failed to fetch/i.test(message)) return "手机暂时无法连接 Windows 网关，请检查 EasyTier";
  if (/timed out|timeout|超时/i.test(message)) return "网关响应超时，请稍后刷新";
  return "读取网关数据失败，请稍后刷新";
}

function metadataReadErrorText(cause: unknown): string {
  return `读取任务参数失败：${gatewayReadErrorText(cause)}`;
}

function loginErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/401|invalid pairing token/i.test(message)) return "配对密钥不正确，请重新输入";
  if (/network|failed to fetch/i.test(message)) return "无法连接 Windows 网关，请检查 EasyTier";
  return "连接失败，请稍后重试";
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function metricRate(rate: number | null | undefined, count: number | undefined): string {
  if (!count || rate == null) return "暂无请求";
  return `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%（${count} 次）`;
}

function metricLatencyPair(p95: number | null | undefined, p99: number | null | undefined): string {
  if (p95 == null || p99 == null) return "暂无请求";
  return `${Math.round(p95)} / ${Math.round(p99)} 毫秒`;
}

function stabilityHealth(diagnostics: DiagnosticsStatus | null): { label: string; className: string } {
  const stability = diagnostics?.stability;
  if (!stability || stability.upstream.requests + stability.snapshots.runs === 0) return { label: "等待数据", className: "" };
  const upstreamRate = stability.upstream.successRate ?? 1;
  const snapshotRate = stability.snapshots.successRate ?? 1;
  if (upstreamRate === 1 && snapshotRate === 1 && stability.reconnects === 0) return { label: "正常", className: "success-text" };
  if (upstreamRate >= 0.95 && snapshotRate >= 0.95) return { label: "有波动", className: "warning-text" };
  return { label: "异常", className: "danger-text" };
}

createRoot(document.getElementById("root")!).render(<App />);
