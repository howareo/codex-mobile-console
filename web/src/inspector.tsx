import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CircleAlert, FileDiff, ShieldAlert, SquareTerminal } from "lucide-react";
import type { ApprovalRequest, JsonObject, ThreadSummary } from "../../src/shared/types";
import { itemRecord, itemType, statusClass, statusText, statusValue, textValue } from "./thread-items";
import { latestPlanFromTurn, planProgress, planSnapshotKey, type PlanProgress, type PlanSnapshot, type PlanStep } from "./plan-state";
import "./inspector.css";

export type ApprovalDecision = "accept" | "decline";
export type InspectorTab = "overview" | "changes" | "log";
export type InspectorRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface InspectorProps {
  /** Selected task id (selectedId in App). Approvals for this task are hidden here; they belong to the thread view. */
  threadId: string | null;
  /** selected.thread.turns for the selected task; the last entry is treated as the latest turn. */
  turns: unknown[];
  /** All known tasks, used to name the tasks behind approvals and to resolve the cwd of the selected task. */
  threads: ThreadSummary[];
  /** Pending approvals (approvals in App). */
  approvals: ApprovalRequest[];
  /** Live plan snapshots keyed by planSnapshotKey(threadId, turnId) (planSnapshots in App). */
  planSnapshots: Record<string, PlanSnapshot>;
  /** Same handler ApprovalPanel uses (decideApproval in App). May reject; the card then shows the error. */
  onDecision: (requestId: string | number, decision: ApprovalDecision) => Promise<void>;
  /** The app's api helper, used for GET /api/diagnostics/status. */
  request: InspectorRequest;
  /** Optional: lets the approval card jump to the task that is waiting. */
  onSelectThread?: ((threadId: string) => void) | undefined;
  /** Diagnostics refresh interval, default 30s. */
  pollMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  kind: "add" | "update" | "delete";
  added: number;
  removed: number;
}

export interface ChangeTotals {
  files: number;
  added: number;
  removed: number;
}

export type CommandState = "running" | "ok" | "failed" | "stopped";

export interface CommandLogEntry {
  id: string;
  command: string;
  exitCode: number | null;
  status: string;
  state: CommandState;
}

export interface PlanView {
  steps: PlanStep[];
  explanation: string | null;
  live: boolean;
}

export interface InspectorDiagnostics {
  upstream?: { state?: string };
  maintenance?: { active?: boolean };
  config?: { state?: "pending" | "applied" | "unknown" };
  claude?: { sdkVersion?: string; expectedCliVersion?: string; cliVersion?: string | null; cliError?: string | null; match?: boolean };
}

export type LinkTone = "ok" | "warn" | "danger" | "muted";

export interface LinkRow {
  label: string;
  value: string;
  tone: LinkTone;
  title?: string;
}

export function approvalThreadId(approval: ApprovalRequest): string | null {
  const value = approval.params.threadId ?? approval.params.conversationId;
  return typeof value === "string" ? value : null;
}

export function approvalSummary(params: JsonObject): string {
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.command)) return params.command.join(" ");
  if (typeof params.reason === "string" && params.reason) return params.reason;
  if (params.permissions) return JSON.stringify(params.permissions);
  return "请在执行前确认此操作";
}

/** Task ids that currently have at least one pending approval. */
export function approvalThreadIds(approvals: readonly ApprovalRequest[]): Set<string> {
  const ids = new Set<string>();
  for (const approval of approvals) {
    const id = approvalThreadId(approval);
    if (id) ids.add(id);
  }
  return ids;
}

/** Approvals that belong to a different, known task than the selected one. */
export function approvalsForOtherTasks(approvals: readonly ApprovalRequest[], threadId: string | null): ApprovalRequest[] {
  return approvals.filter(approval => {
    const owner = approvalThreadId(approval);
    return owner !== null && owner !== threadId;
  });
}

export function latestTurn(turns: readonly unknown[]): Record<string, unknown> | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (typeof turn === "object" && turn !== null && !Array.isArray(turn)) return turn as Record<string, unknown>;
  }
  return null;
}

function turnItems(turn: unknown): unknown[] {
  const items = itemRecord(turn).items;
  return Array.isArray(items) ? items : [];
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Counts added/removed lines in a unified diff, ignoring the ---/+++ file headers. */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed };
}

function changeKind(kind: unknown): ChangedFile["kind"] {
  const value = typeof kind === "string" ? kind : textValue(itemRecord(kind).type);
  return value === "add" || value === "delete" ? value : "update";
}

// Codex sends the full file content (no +/- prefixes) as the "diff" of an added or deleted file.
function changeLineCounts(change: Record<string, unknown>, kind: ChangedFile["kind"]): { added: number; removed: number } {
  const diff = textValue(change.diff);
  let counts: { added: number; removed: number };
  if (kind !== "update" && !/^@@ /m.test(diff)) counts = kind === "add" ? { added: countLines(diff), removed: 0 } : { added: 0, removed: countLines(diff) };
  else counts = countDiffLines(diff);
  return {
    added: typeof change.added === "number" ? change.added : counts.added,
    removed: typeof change.removed === "number" ? change.removed : counts.removed
  };
}

function mergeKind(previous: ChangedFile["kind"], next: ChangedFile["kind"]): ChangedFile["kind"] {
  if (next === "delete") return "delete";
  if (previous === "add") return "add";
  return next;
}

/** Files touched by fileChange items of one turn, merged per path (counts are summed). Declined and failed changes are skipped. */
export function changedFilesFromTurn(turn: unknown): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const item of turnItems(turn)) {
    if (itemType(item) !== "fileChange") continue;
    if (statusClass(itemRecord(item).status) === "failed") continue;
    const changes = itemRecord(item).changes;
    if (!Array.isArray(changes)) continue;
    for (const raw of changes) {
      const change = itemRecord(raw);
      const path = textValue(change.path);
      if (!path) continue;
      const kind = changeKind(change.kind);
      const counts = changeLineCounts(change, kind);
      const key = path.replaceAll("\\", "/").toLowerCase();
      const existing = files.get(key);
      if (existing) {
        existing.kind = mergeKind(existing.kind, kind);
        existing.added += counts.added;
        existing.removed += counts.removed;
      } else files.set(key, { path, kind, ...counts });
    }
  }
  return [...files.values()];
}

export function changeTotals(files: readonly ChangedFile[]): ChangeTotals {
  return files.reduce((totals, file) => ({ files: totals.files + 1, added: totals.added + file.added, removed: totals.removed + file.removed }), { files: 0, added: 0, removed: 0 });
}

/** Path relative to the task cwd when it lies inside it, otherwise the last three segments. */
export function displayPath(path: string, cwd?: string | null): string {
  const normalized = path.replaceAll("\\", "/");
  const base = cwd ? cwd.replaceAll("\\", "/").replace(/\/+$/, "") : "";
  if (base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return normalized.slice(base.length + 1);
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
}

/** The latest turn's plan: the live snapshot when present, otherwise the plan item stored in the turn. */
export function planForTurn(threadId: string | null, turn: unknown, snapshots: Record<string, PlanSnapshot>): PlanView | null {
  const turnId = itemRecord(turn).id;
  const live = threadId && typeof turnId === "string" ? snapshots[planSnapshotKey(threadId, turnId)] : undefined;
  if (live && live.plan.length > 0) return { steps: live.plan, explanation: live.explanation ?? null, live: true };
  const stored = latestPlanFromTurn(turn);
  return stored ? { steps: stored, explanation: null, live: false } : null;
}

/** 0-100 for the conic progress ring: completed steps over total steps. */
export function planRingPercent(plan: readonly PlanStep[]): number {
  const progress: PlanProgress = planProgress(plan);
  return progress.total === 0 ? 0 : Math.round(progress.completed / progress.total * 100);
}

function commandText(value: unknown): string {
  return Array.isArray(value) ? value.map(textValue).filter(Boolean).join(" ") : textValue(value);
}

function commandState(status: string, exitCode: number | null): CommandState {
  const kind = statusClass(status);
  if (kind === "running") return "running";
  if (exitCode !== null) return exitCode === 0 ? "ok" : "failed";
  if (kind === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "stopped";
  return kind === "done" ? "ok" : "running";
}

/** Command executions of one turn, newest first. */
export function commandsFromTurn(turn: unknown, limit = 20): CommandLogEntry[] {
  const entries: CommandLogEntry[] = [];
  turnItems(turn).forEach((item, index) => {
    if (itemType(item) !== "commandExecution") return;
    const record = itemRecord(item);
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
    const status = statusValue(record.status);
    const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : `command-${index}`;
    entries.push({ id, command: commandText(record.command) || "（无命令文本）", exitCode, status, state: commandState(status, exitCode) });
  });
  return entries.reverse().slice(0, Math.max(0, limit));
}

/** Rows of the 链路 panel. Pass null when the status could not be read yet. */
export function linkRows(status: InspectorDiagnostics | null): LinkRow[] {
  const upstream = status?.upstream?.state;
  const upstreamRow: LinkRow = upstream === "open"
    ? { label: "4500 共享服务", value: "已连接", tone: "ok" }
    : upstream === "connecting" || upstream === "reconnecting"
      ? { label: "4500 共享服务", value: upstream === "connecting" ? "连接中" : "重连中", tone: "warn" }
      : upstream === "closed"
        ? { label: "4500 共享服务", value: "已断开", tone: "danger" }
        : { label: "4500 共享服务", value: "未知", tone: "muted" };
  const maintenance: LinkRow = status?.maintenance?.active
    ? { label: "维护窗口", value: "进行中", tone: "warn" }
    : { label: "维护窗口", value: "无", tone: "muted" };
  const configState = status?.config?.state;
  const config: LinkRow = configState === "pending"
    ? { label: "待重载配置", value: "有", tone: "warn", title: "配置将在维护窗口内应用" }
    : configState === "applied"
      ? { label: "待重载配置", value: "无", tone: "muted" }
      : { label: "待重载配置", value: "暂不可确认", tone: "muted" };
  const claude = status?.claude;
  const versions = claude ? `CLI ${claude.cliVersion ?? "未检测到"} / SDK 期望 ${claude.expectedCliVersion ?? "未知"}` : undefined;
  const claudeRow: LinkRow = !claude
    ? { label: "Claude CLI", value: "未知", tone: "muted" }
    : claude.match
      ? { label: "Claude CLI", value: claude.cliVersion ? `版本一致 ${claude.cliVersion}` : "版本一致", tone: "ok", ...(versions ? { title: versions } : {}) }
      : claude.cliVersion
        ? { label: "Claude CLI", value: "版本不一致", tone: "warn", ...(versions ? { title: versions } : {}) }
        : { label: "Claude CLI", value: "未检测到", tone: "warn", title: claude.cliError || versions || "无法读取 CLI 版本" };
  return [upstreamRow, maintenance, config, claudeRow];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 30_000;
const OVERVIEW_FILE_LIMIT = 5;
const TAB_ORDER: InspectorTab[] = ["overview", "changes", "log"];

function threadName(thread: ThreadSummary | undefined, fallback: string | null): string {
  return thread?.name || thread?.title || fallback || "未命名任务";
}

function approvalCommandHead(params: JsonObject): { head: string; rest: string } | null {
  if (typeof params.command !== "string" && !Array.isArray(params.command)) return null;
  const text = approvalSummary(params).trim();
  const split = text.search(/\s/);
  return split < 0 ? { head: text, rest: "" } : { head: text.slice(0, split), rest: text.slice(split) };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "操作失败，请重试";
}

export function Inspector({ threadId, turns, threads, approvals, planSnapshots, onDecision, request, onSelectThread, pollMs = DEFAULT_POLL_MS }: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("overview");
  const turn = latestTurn(turns);
  const cwd = threads.find(thread => thread.id === threadId)?.cwd ?? null;
  const files = changedFilesFromTurn(turn);
  const totals = changeTotals(files);
  const commands = commandsFromTurn(turn);
  const plan = planForTurn(threadId, turn, planSnapshots);
  const otherApprovals = approvalsForOtherTasks(approvals, threadId);
  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({ overview: null, changes: null, log: null });

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TAB_ORDER[(TAB_ORDER.indexOf(tab) + step + TAB_ORDER.length) % TAB_ORDER.length] ?? "overview";
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabLabel: Record<InspectorTab, string> = { overview: "概况", changes: files.length > 0 ? `改动 ${files.length}` : "改动", log: "日志" };

  return <aside className="insp" aria-label="任务检查器">
    <div className="insp-tabs" role="tablist" aria-label="检查器分区">
      {TAB_ORDER.map(id => <button key={id} ref={node => { tabRefs.current[id] = node; }} id={`insp-tab-${id}`} type="button" role="tab" className={tab === id ? "on" : ""} aria-selected={tab === id} aria-controls="insp-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={onTabKey}>{tabLabel[id]}</button>)}
    </div>
    <div id="insp-panel" className="insp-body" role="tabpanel" aria-labelledby={`insp-tab-${tab}`}>
      {otherApprovals.map(approval => <ApprovalCard key={String(approval.id)} approval={approval} thread={threads.find(item => item.id === approvalThreadId(approval))} onDecision={onDecision} onSelectThread={onSelectThread} />)}
      {tab === "overview" && <>
        <PlanPanel plan={plan} />
        <ChangesPanel files={files} totals={totals} cwd={cwd} limit={OVERVIEW_FILE_LIMIT} onShowAll={() => setTab("changes")} />
        <LinkPanel request={request} pollMs={pollMs} />
      </>}
      {tab === "changes" && <ChangesPanel files={files} totals={totals} cwd={cwd} />}
      {tab === "log" && <LogPanel commands={commands} />}
    </div>
  </aside>;
}

function ApprovalCard({ approval, thread, onDecision, onSelectThread }: { approval: ApprovalRequest; thread: ThreadSummary | undefined; onDecision: InspectorProps["onDecision"]; onSelectThread: InspectorProps["onSelectThread"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = approvalThreadId(approval);
  const name = threadName(thread, owner);
  const command = approvalCommandHead(approval.params);
  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await onDecision(approval.id, decision);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return <section className="insp-panel ask" aria-label={`等你确认：${name}`}>
    <h4><span className="insp-h-main"><ShieldAlert size={14} aria-hidden="true" />等你确认</span></h4>
    {onSelectThread && owner ? <button type="button" className="insp-task-link" onClick={() => onSelectThread(owner)}>{name}</button> : <p className="insp-task">{name}</p>}
    <div className="insp-cmd">{command ? <><b>{command.head}</b>{command.rest}</> : approvalSummary(approval.params)}</div>
    {error && <p className="insp-error" role="alert"><CircleAlert size={13} aria-hidden="true" />{error}</p>}
    <div className="insp-choices">
      <button type="button" className="no" disabled={busy} onClick={() => void decide("decline")}>拒绝</button>
      <button type="button" className="yes" disabled={busy} onClick={() => void decide("accept")}>允许执行</button>
    </div>
  </section>;
}

function PlanPanel({ plan }: { plan: PlanView | null }) {
  if (!plan) return <section className="insp-panel"><h4>计划</h4><p className="insp-empty">本轮没有计划</p></section>;
  const progress = planProgress(plan.steps);
  const percent = planRingPercent(plan.steps);
  return <section className="insp-panel" aria-label={`计划，已完成 ${progress.completed} / ${progress.total}`}>
    <h4>计划<span className="insp-h-side"><span className="insp-count">{progress.completed} / {progress.total}</span><span className="insp-ring" role="img" aria-label={`进度 ${percent}%`} style={{ "--p": percent } as CSSProperties} /></span></h4>
    {plan.explanation && <p className="insp-note">{plan.explanation}</p>}
    <ol className="insp-plan">{plan.steps.map((step, index) => <li key={`${index}-${step.step}`} className={step.status}><span className="insp-sr">{step.status === "completed" ? "已完成：" : step.status === "inProgress" ? "进行中：" : "待办："}</span>{step.step}</li>)}</ol>
  </section>;
}

const KIND_LABEL: Record<ChangedFile["kind"], string> = { add: "新建", update: "更新", delete: "删除" };

function ChangesPanel({ files, totals, cwd, limit, onShowAll }: { files: ChangedFile[]; totals: ChangeTotals; cwd: string | null; limit?: number; onShowAll?: () => void }) {
  const shown = limit === undefined ? files : files.slice(0, limit);
  return <section className="insp-panel">
    <h4>本轮改动{files.length > 0 && <span className="insp-h-side"><span className="insp-a">+{totals.added}</span><span className="insp-d">−{totals.removed}</span></span>}</h4>
    {files.length === 0 ? <p className="insp-empty"><FileDiff size={14} aria-hidden="true" />本轮暂无文件改动</p> : <ul className="insp-files">
      {shown.map(file => <li key={file.path}>
        <span className="insp-path" title={file.path}>{displayPath(file.path, cwd)}</span>
        {limit === undefined && <span className={`insp-kind ${file.kind}`}>{KIND_LABEL[file.kind]}</span>}
        <span className="insp-a">+{file.added}</span><span className="insp-d">−{file.removed}</span>
      </li>)}
    </ul>}
    {onShowAll && files.length > shown.length && <button type="button" className="insp-more" onClick={onShowAll}>另有 {files.length - shown.length} 个文件，查看全部</button>}
  </section>;
}

function LogPanel({ commands }: { commands: CommandLogEntry[] }) {
  return <section className="insp-panel">
    <h4>最近命令{commands.length > 0 && <span className="insp-h-side"><span className="insp-count">{commands.length} 条</span></span>}</h4>
    {commands.length === 0 ? <p className="insp-empty"><SquareTerminal size={14} aria-hidden="true" />本轮还没有执行命令</p> : <ul className="insp-log">
      {commands.map(entry => <li key={entry.id}>
        <code title={entry.command}>{entry.command}</code>
        <span className={`insp-pill ${entry.state}`}>{entry.exitCode !== null ? `退出 ${entry.exitCode}` : statusText(entry.status)}</span>
      </li>)}
    </ul>}
  </section>;
}

function LinkPanel({ request, pollMs }: { request: InspectorRequest; pollMs: number }) {
  const [status, setStatus] = useState<InspectorDiagnostics | null>(null);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = () => {
      requestRef.current<InspectorDiagnostics>("/api/diagnostics/status")
        .then(result => { if (active) { setStatus(result); setFailed(false); } })
        .catch(() => { if (active) { setStatus(null); setFailed(true); } });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (!active || document.visibilityState === "hidden") return;
      load();
      timer = window.setTimeout(schedule, pollMs);
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [pollMs]);
  return <section className="insp-panel">
    <h4>链路</h4>
    {failed ? <p className="insp-quiet">无法读取</p> : <div className="insp-kv">
      {linkRows(status).map(row => <div className="insp-kv-row" key={row.label}><span>{row.label}</span><b className={row.tone} title={row.title}>{row.tone === "ok" && <i className="insp-dot" aria-hidden="true" />}{row.value}</b></div>)}
    </div>}
  </section>;
}
