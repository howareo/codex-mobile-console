import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import type { ApprovalRequest, ThreadSummary } from "../../src/shared/types";
import { statusClass, statusText } from "./thread-items";
import { approvalThreadIds } from "./inspector";
import "./command-palette.css";

export type ThreadFilter = "all" | "running" | "approval" | "failed";

export interface CommandPaletteProps {
  /** Controlled open state; the palette itself only reports changes. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All tasks (threads in App). */
  threads: ThreadSummary[];
  /** Pending approvals (approvals in App); tasks with one get a 待确认 marker. */
  approvals?: ApprovalRequest[];
  /** Called with the chosen task id; the palette closes itself afterwards. */
  onSelect: (threadId: string) => void;
}

export interface ThreadFilterChipsProps {
  threads: ThreadSummary[];
  approvals: ApprovalRequest[];
  value: ThreadFilter;
  onChange: (filter: ThreadFilter) => void;
}

export interface PaletteTriggerProps {
  onClick: () => void;
  label?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function threadDisplayName(thread: ThreadSummary): string {
  return thread.name || thread.title || "未命名任务";
}

/** Project folder shown in lists: the folder under Desktop when there is one, otherwise the last cwd segment. */
export function threadProject(cwd: string | null | undefined): string {
  if (!cwd) return "其他任务";
  const parts = cwd.replaceAll("/", "\\").split("\\").filter(Boolean);
  const desktopIndex = parts.findIndex(part => part.toLowerCase() === "desktop");
  return parts[desktopIndex >= 0 ? desktopIndex + 1 : parts.length - 1] || "其他任务";
}

export function threadMatchesFilter(thread: ThreadSummary, filter: ThreadFilter, approvalIds: ReadonlySet<string>): boolean {
  if (filter === "all") return true;
  if (filter === "approval") return approvalIds.has(thread.id);
  return statusClass(thread.status) === filter;
}

/** List-pane filter: 全部 / 运行中 / 待确认 (has a pending approval) / 失败. */
export function filterThreads(threads: readonly ThreadSummary[], filter: ThreadFilter, approvals: readonly ApprovalRequest[]): ThreadSummary[] {
  if (filter === "all") return [...threads];
  const approvalIds = approvalThreadIds(approvals);
  return threads.filter(thread => threadMatchesFilter(thread, filter, approvalIds));
}

export function threadFilterCounts(threads: readonly ThreadSummary[], approvals: readonly ApprovalRequest[]): Record<ThreadFilter, number> {
  return {
    all: threads.length,
    running: filterThreads(threads, "running", approvals).length,
    approval: filterThreads(threads, "approval", approvals).length,
    failed: filterThreads(threads, "failed", approvals).length
  };
}

/**
 * Case-insensitive substring search over name, project folder and cwd. Every
 * whitespace-separated token must match somewhere; name matches rank first,
 * then project, then cwd. An empty query keeps the original order.
 */
export function searchThreads(threads: readonly ThreadSummary[], query: string): ThreadSummary[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...threads];
  const ranked: Array<{ thread: ThreadSummary; score: number; index: number }> = [];
  threads.forEach((thread, index) => {
    const fields = [threadDisplayName(thread), threadProject(thread.cwd), thread.cwd ?? ""].map(value => value.toLowerCase());
    let score = 0;
    for (const token of tokens) {
      const field = fields.findIndex(value => value.includes(token));
      if (field < 0) return;
      score = Math.max(score, field);
    }
    ranked.push({ thread, score, index });
  });
  return ranked.sort((a, b) => a.score - b.score || a.index - b.index).map(entry => entry.thread);
}

export function isPaletteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

function shortcutLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const RESULT_LIMIT = 50;

/** Search-box look-alike for the list pane header; opens the palette. */
export function PaletteTrigger({ onClick, label = "搜索任务、项目、目录" }: PaletteTriggerProps) {
  return <button type="button" className="cp-trigger" onClick={onClick} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K"><Search size={15} aria-hidden="true" /><span>{label}</span><kbd>{shortcutLabel()}</kbd></button>;
}

const FILTERS: Array<{ id: ThreadFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "approval", label: "待确认" },
  { id: "failed", label: "失败" }
];

export function ThreadFilterChips({ threads, approvals, value, onChange }: ThreadFilterChipsProps) {
  const counts = threadFilterCounts(threads, approvals);
  return <div className="cp-chips" role="group" aria-label="任务筛选">
    {FILTERS.map(filter => <button key={filter.id} type="button" className={`${value === filter.id ? "on" : ""} ${filter.id}`} aria-pressed={value === filter.id} onClick={() => onChange(filter.id)}>{filter.label} {counts[filter.id]}</button>)}
  </div>;
}

export function CommandPalette({ open, onOpenChange, threads, approvals = [], onSelect }: CommandPaletteProps) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      onOpenChange(!openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);
  if (!open) return null;
  return <PaletteDialog threads={threads} approvals={approvals} onClose={() => onOpenChange(false)} onSelect={onSelect} />;
}

function PaletteDialog({ threads, approvals, onClose, onSelect }: { threads: ThreadSummary[]; approvals: ApprovalRequest[]; onClose: () => void; onSelect: (threadId: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const approvalIds = approvalThreadIds(approvals);
  const matches = searchThreads(threads, query);
  const results = matches.slice(0, RESULT_LIMIT);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const activeId = results[activeIndex] ? `${baseId}-opt-${activeIndex}` : undefined;

  // Focus the field on open and give focus back to whatever had it before.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (thread: ThreadSummary | undefined) => {
    if (!thread) return;
    onSelect(thread.id);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Home" || event.key === "End") {
      if (results.length === 0) return;
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : results.length - 1);
    } else if (event.key === "Enter") {
      // Enter while composing (Chinese/Japanese IME) confirms the candidate, it must not pick a task.
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      choose(results[activeIndex]);
    } else if (event.key === "Tab") {
      // Focus trap: the input is the only focusable element.
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  return <div className="cp-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="cp" role="dialog" aria-modal="true" aria-label="搜索任务" onKeyDown={onKeyDown}>
      <div className="cp-search">
        <Search size={16} aria-hidden="true" />
        <input ref={inputRef} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" aria-label="搜索任务、项目、目录" placeholder="搜索任务、项目、目录" autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} />
        <kbd>Esc</kbd>
      </div>
      <ul className="cp-list" id={listId} role="listbox" aria-label="任务">
        {results.map((thread, index) => {
          const pending = approvalIds.has(thread.id);
          const state = pending ? "approval" : statusClass(thread.status);
          return <li key={thread.id} id={`${baseId}-opt-${index}`} role="option" aria-selected={index === activeIndex} className={`cp-row ${index === activeIndex ? "on" : ""}`} title={thread.cwd || undefined} onMouseMove={() => { if (index !== activeIndex) setActive(index); }} onClick={() => choose(thread)}>
            <span className={`cp-dot ${state}`} aria-hidden="true" />
            <span className="cp-name">{threadDisplayName(thread)}</span>
            <span className="cp-project">{threadProject(thread.cwd)}</span>
            <span className={`cp-state ${state}`}>{pending ? "待确认" : statusText(thread.status)}</span>
          </li>;
        })}
      </ul>
      {results.length === 0 && <p className="cp-empty">{threads.length === 0 ? "暂无任务" : "没有匹配的任务"}</p>}
      <div className="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span>
        {matches.length > results.length && <span className="cp-more">仅显示前 {RESULT_LIMIT} 项</span>}
      </div>
      <div className="cp-sr" role="status" aria-live="polite">{matches.length} 个结果</div>
    </div>
  </div>;
}
