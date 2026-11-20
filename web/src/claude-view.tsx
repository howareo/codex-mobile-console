import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Clock3, FolderClosed, LoaderCircle, Plus, RefreshCw, Send, Square } from "lucide-react";
import type { ClaudeApproval, ClaudeHistoryPage, ClaudeRunOptions, ClaudeRunSnapshot, ClaudeSessionList, ClaudeSessionSummary } from "../../src/shared/claude";
import { claudeStatusClass, mergeClaudeRun } from "./claude-state";
import { normalizeThreadCwd, uniqueThreadCwds } from "../../src/shared/cwd";
import { ClaudeRunProgress, ClaudeSettingsPanel, ClaudeTasks } from "./claude-controls";
import { ThreadMessages } from "./thread-messages";
import { JumpToLatest, useFollowOutput } from "./follow-output";
import { itemRole } from "./thread-items";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function ClaudeView({ request, drafts, onDraftChange, onConversationChange }: {
  request: Request; drafts: Record<string, string>;
  onDraftChange: (id: string, text: string) => void; onConversationChange: (open: boolean) => void;
}) {
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<ClaudeHistoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [runs, setRuns] = useState<Record<string, ClaudeRunSnapshot>>({});
  const [liveState, setLiveState] = useState("正在连接");
  const [controlEnabled, setControlEnabled] = useState(false);
  const [settingsEnabled, setSettingsEnabled] = useState(false);
  const [createEnabled, setCreateEnabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createCwd, setCreateCwd] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const creationAttempt = useRef<{ cwd: string; requestId: string } | null>(null);
  const [optionsBySession, setOptionsBySession] = useState<Record<string, ClaudeRunOptions>>(() => {
    try { const value = JSON.parse(localStorage.getItem("codex-mobile-claude-options") || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [actionBusy, setActionBusy] = useState(false);
  const [syncedRequest, setSyncedRequest] = useState<string | null>(null);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const attempts = useRef(new Map<string, { text: string; requestId: string; options?: ClaudeRunOptions }>());
  const listAbort = useRef<AbortController | null>(null);
  const historyAbort = useRef<AbortController | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { onConversationChange(Boolean(selectedId)); return () => onConversationChange(false); }, [selectedId, onConversationChange]);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ capabilities?: { control?: boolean; settings?: boolean; createSession?: boolean } }>("/api/claude/status", { signal: controller.signal })
      .then(status => { if (!controller.signal.aborted) { setControlEnabled(status.capabilities?.control === true); setSettingsEnabled(status.capabilities?.settings === true); setCreateEnabled(status.capabilities?.createSession === true); } })
      .catch(() => { if (!controller.signal.aborted) setControlEnabled(false); });
    return () => controller.abort();
  }, [request, revision]);

  useEffect(() => {
    if (!controlEnabled) return;
    const source = new EventSource("/api/claude/events");
    source.onopen = () => setLiveState("实时连接正常");
    source.onerror = () => setLiveState("连接中断，正在重连");
    source.onmessage = event => {
      try {
        const update = JSON.parse(event.data) as { runs?: ClaudeRunSnapshot[]; run?: ClaudeRunSnapshot };
        if (update.runs) setRuns(Object.fromEntries(update.runs.map(run => [run.sessionId, run])));
        else if (update.run) setRuns(current => mergeClaudeRun(current, update.run!));
      } catch { setLiveState("实时数据异常，请刷新"); }
    };
    return () => { source.close(); };
  }, [controlEnabled]);

  useEffect(() => {
    const pop = (event: PopStateEvent) => setSelectedId(typeof event.state?.codexMobileClaudeSessionId === "string" ? event.state.codexMobileClaudeSessionId : null);
    window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("popstate", pop); listAbort.current?.abort(); historyAbort.current?.abort(); };
  }, []);

  const loadList = async (cursor?: string) => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await request<ClaudeSessionList>(`/api/claude/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSessions(current => cursor ? [...new Map([...current, ...result.data].map(session => [session.id, session])).values()] : result.data);
      setNextCursor(result.nextCursor);
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };

  useEffect(() => { void loadList(); }, [revision]);

  const loadHistory = async (id: string, cursor?: string) => {
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    setHistoryBusy(true);
    setError(null);
    const finished = runsRef.current[id]?.finishedAt ? runsRef.current[id]!.requestId : null;
    try {
      const url = (next?: string) => `/api/claude/sessions/${encodeURIComponent(id)}${next ? `?cursor=${encodeURIComponent(next)}` : ""}`;
      let result = await request<ClaudeHistoryPage>(url(cursor), { signal: controller.signal });
      // A page holds 30 records and older Claude pages are often all tool
      // calls and thinking, which fold into the collapsed group and look like
      // nothing loaded. Keep paging (bounded) until real conversation appears.
      if (cursor) {
        const older = [...result.messages];
        for (let extra = 0; extra < 5 && result.olderCursor && !older.some(hasConversation); extra += 1) {
          result = await request<ClaudeHistoryPage>(url(result.olderCursor), { signal: controller.signal });
          older.unshift(...result.messages);
        }
        result = { ...result, messages: older };
      }
      if (controller.signal.aborted || selectedRef.current !== id) return;
      // Prepending older records must not move what the reader is looking at.
      const before = document.documentElement.scrollHeight;
      setPage(current => cursor && current?.session.id === id ? { ...result,
        messages: [...new Map([...result.messages, ...current.messages].map(message => [message.id, message])).values()] } : result);
      if (cursor) requestAnimationFrame(() => window.scrollBy({ top: document.documentElement.scrollHeight - before }));
      if (!cursor && finished) setSyncedRequest(finished);
    } catch (cause) { if (!controller.signal.aborted && selectedRef.current === id) setError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setHistoryBusy(false); }
  };

  useEffect(() => {
    historyAbort.current?.abort();
    setPage(null);
    setSyncedRequest(null);
    if (selectedId) void loadHistory(selectedId);
    else setHistoryBusy(false);
  }, [selectedId, revision]);


  const run = selectedId ? runs[selectedId] : undefined;
  const selectedStatus = run?.status || sessions.find(session => session.id === selectedId)?.status || page?.session.status || "unknown";
  const running = Boolean(run && run.finishedAt === null);
  const liveMessages = run && syncedRequest !== run.requestId ? run.messages.filter(message => !page?.messages.some(saved => saved.id === message.id)) : [];
  // Track the newest record only, so loading older history never reads as new output.
  const outputVersion = `${page?.messages.at(-1)?.id ?? ""}:${run?.status ?? ""}:${(run?.messages ?? []).map(message => `${message.id}:${JSON.stringify(message.items).length}`).join("|")}`;
  const follow = useFollowOutput(bottom, outputVersion, page?.session.id ?? null);
  useEffect(() => {
    if (selectedId && run?.finishedAt && page?.session.id === selectedId && syncedRequest !== run.requestId) void loadHistory(selectedId);
  }, [selectedId, run?.requestId, run?.finishedAt]);

  const send = async () => {
    if (!controlEnabled || !selectedId || actionBusy || running) return;
    const id = selectedId;
    const key = `claude:${id}`;
    const text = (drafts[key] || "").trim();
    if (!text) return;
    const previous = attempts.current.get(id);
    const options = settingsEnabled ? optionsBySession[id] || {} : undefined;
    const attempt = previous?.text === text && JSON.stringify(previous.options) === JSON.stringify(options) ? previous : { text, requestId: crypto.randomUUID(), ...(options ? { options } : {}) };
    attempts.current.set(id, attempt);
    setActionBusy(true);
    setError(null);
    try {
      const result = await request<ClaudeRunSnapshot>(`/api/claude/sessions/${id}/messages`, { method: "POST", body: JSON.stringify(attempt) });
      setRuns(current => mergeClaudeRun(current, result));
      attempts.current.delete(id);
      if (draftsRef.current[key]?.trim() === text) onDraftChange(key, "");
      follow.jump(false);
    } catch (cause) { if (selectedRef.current === id) setError(errorText(cause)); }
    finally { setActionBusy(false); }
  };

  const control = async (action: string, body: object = {}) => {
    if (!controlEnabled || !selectedId || !run || actionBusy) return;
    const id = selectedId;
    setActionBusy(true);
    setError(null);
    try {
      const result = await request<ClaudeRunSnapshot>(`/api/claude/sessions/${id}/${action}`, { method: "POST", body: JSON.stringify({ requestId: run.requestId, ...body }) });
      setRuns(current => mergeClaudeRun(current, result));
    } catch (cause) { if (selectedRef.current === id) setError(errorText(cause)); }
    finally { setActionBusy(false); }
  };

  const open = (id: string) => {
    window.history.pushState({ codexMobileProvider: "claude", codexMobileClaudeSessionId: id }, "", window.location.href);
    setSelectedId(id);
    setError(null);
  };
  const create = async () => {
    const cwd = normalizeThreadCwd(createCwd);
    if (!cwd || createBusy || !createEnabled) return;
    if (creationAttempt.current?.cwd !== cwd) creationAttempt.current = { cwd, requestId: crypto.randomUUID() };
    setCreateBusy(true);
    setError(null);
    try {
      const session = await request<ClaudeSessionSummary>("/api/claude/sessions", { method: "POST", body: JSON.stringify(creationAttempt.current) });
      listAbort.current?.abort();
      setBusy(false);
      setSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
      creationAttempt.current = null;
      setCreating(false);
      open(session.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setCreateBusy(false); }
  };
  const back = () => {
    if (window.history.state?.codexMobileClaudeSessionId === selectedId) window.history.back();
    setSelectedId(null);
    setError(null);
  };
  const groups = new Map<string, ClaudeSessionSummary[]>();
  for (const session of sessions) {
    const cwd = session.cwd || "未知项目";
    const group = groups.get(cwd) || [];
    group.push(session);
    groups.set(cwd, group);
  }

  return <div className={`threads-layout claude-layout ${selectedId ? "has-selection" : ""}`}>
    <div className="claude-notice" role="status"><strong>Claude Code · {controlEnabled ? "手机控制" : "历史预览"}</strong><span>{controlEnabled ? `${liveState}。手机发起的任务支持流式回答、公开思考、工具过程、停止和审批。电脑终端仍占用的会话需先退出该终端。` : "历史浏览可继续使用；控制服务尚未就绪。更新 4600 和手机网关后，点击刷新即可开放发送功能。"}</span></div>
    {error && <div className="claude-error" role="alert"><span>{error}</span><button className="secondary-button compact" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    <section className="thread-list">
      <div className="section-heading"><div><p className="eyebrow">CLAUDE CODE</p><h1>会话</h1></div><div className="list-actions"><button className="secondary-button compact" type="button" disabled={!createEnabled || createBusy} onClick={() => { setCreateCwd(value => value || uniqueThreadCwds(sessions)[0] || ""); setCreating(true); setError(null); }}><Plus size={15} />新建会话</button><button className="secondary-button compact" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={busy ? "spin" : undefined} />刷新</button></div></div>
      {creating && <form className="create-thread-panel" onSubmit={event => { event.preventDefault(); void create(); }}><label>工作目录<select aria-label="Claude 已有项目目录" value={uniqueThreadCwds(sessions).includes(createCwd) ? createCwd : ""} onChange={event => setCreateCwd(event.target.value)} disabled={createBusy}><option value="">选择已有项目</option>{uniqueThreadCwds(sessions).map(cwd => <option value={cwd} key={cwd}>{cwd}</option>)}</select><input aria-label="Claude 绝对工作目录" placeholder="C:\\path\\to\\project" value={createCwd} onChange={event => setCreateCwd(event.target.value)} disabled={createBusy} /></label><small>创建后可选择模型和权限；发送第一条消息时才启动 Claude。</small><div className="create-thread-actions"><button className="secondary-button compact" type="button" disabled={createBusy} onClick={() => { setCreating(false); setError(null); }}>取消</button><button className="primary-button compact" disabled={createBusy || !normalizeThreadCwd(createCwd)}>{createBusy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{createBusy ? "正在创建" : "创建会话"}</button></div></form>}
      {busy && sessions.length === 0 && <div className="empty-state"><LoaderCircle className="spin" size={24} /><p>正在读取 Claude 会话</p></div>}
      {!busy && !error && sessions.length === 0 && <div className="empty-state"><FolderClosed size={25} /><p>当前 Windows 用户下暂无可见 Claude 会话</p></div>}
      <div className="thread-groups">{[...groups].map(([cwd, items]) => <section className="thread-group" key={cwd}>
        <div className="thread-group-heading" title={cwd}><FolderClosed size={15} /><strong>{cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || cwd}</strong><span>{items.length}</span></div>
        <div className="thread-items">{items.map(session => {
          const status = runs[session.id]?.status || session.status;
          const state = claudeStatusClass(status);
          return <button className="thread-row" key={session.id} onClick={() => open(session.id)}>
            <span className={`status-dot ${state}`} /><span className="thread-copy"><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString()} · 最近记录时间</small></span><span className={`thread-status ${state}`}>{session.pending && !runs[session.id] ? "新会话" : statusText(status)}</span><ChevronRight size={16} />
          </button>;
        })}</div>
      </section>)}</div>
      {nextCursor && <button className="history-button" disabled={busy} onClick={() => void loadList(nextCursor)}>{busy ? "正在加载" : "加载更多会话"}</button>}
    </section>
    <section className="thread-detail">
      <button className="detail-back" onClick={back}><ArrowLeft size={18} /><span>返回 Claude 会话</span></button>
      {historyBusy && !page && <div className="empty-state"><LoaderCircle className="spin" size={24} /><p>正在读取历史</p></div>}
      {page?.session.id === selectedId && <>
        <div className="detail-heading"><div><p className="eyebrow">CLAUDE CODE</p><h2>{page.session.title}</h2><span className="detail-meta"><Clock3 size={14} />{page.session.cwd || "未知项目"}</span></div><div className="detail-state"><span className={`state-pill ${claudeStatusClass(selectedStatus)}`}>{page.session.pending && !run ? "新会话" : statusText(selectedStatus)}</span><button className="secondary-button compact" disabled={historyBusy} onClick={() => selectedId && void loadHistory(selectedId)}><RefreshCw size={15} />刷新历史</button></div></div>
        <div className="turn-list">{page.olderCursor && <button className="history-button" disabled={historyBusy} onClick={() => selectedId && void loadHistory(selectedId, page.olderCursor!)}>{historyBusy ? "正在加载" : "加载更早记录"}</button>}
          {page.messages.length === 0 && <div className="empty-state compact"><p>暂无可见历史</p></div>}
          <ThreadMessages items={page.messages.flatMap(message => message.items)} />
          {run && (running || liveMessages.length > 0) && <section className="turn claude-live-turn" aria-label="Claude 当前任务">
            <div className={`turn-label ${run.status === "failed" ? "failed" : running ? "running" : "done"}`}><span>{running && <LoaderCircle className="spin" size={13} />} Claude · {statusText(run.status)}</span></div>
            <ThreadMessages items={liveMessages.flatMap(message => message.items)} active={running} />
          </section>}
        </div>
        {run && <ClaudeTasks run={run} />}
        {run?.error && <p className="claude-error" role="alert">{run.error}</p>}
        {run?.approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} busy={actionBusy} onDecision={(allow, answers) => void control(`approvals/${approval.id}`, { allow, ...(answers ? { answers } : {}) })} />)}
        <form className="message-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <JumpToLatest away={follow.away} unseen={follow.unseen} onJump={() => follow.jump()} />
          {run && <ClaudeRunProgress run={run} />}
          <ClaudeSettingsPanel key={selectedId!} id={selectedId!} request={request} run={run} enabled={settingsEnabled} options={optionsBySession[selectedId!] || {}} onChange={options => {
            setOptionsBySession(current => {
              const next = { ...current, [selectedId!]: options };
              try { localStorage.setItem("codex-mobile-claude-options", JSON.stringify(next)); } catch { /* Keep in-memory choices when browser storage is unavailable. */ }
              return next;
            });
          }} />
          {error && <div className="composer-feedback error" role="alert">{error}</div>}
          <textarea aria-label="发给 Claude 的消息" placeholder={running ? "任务进行中，可先写下一条消息" : "发消息给 Claude…"} rows={1} maxLength={16_000} value={drafts[`claude:${selectedId}`] || ""} onChange={event => selectedId && onDraftChange(`claude:${selectedId}`, event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} />
          <div className="composer-actions">{running ? <button type="button" className="composer-button stop" aria-label="停止 Claude 任务" disabled={actionBusy || run?.status === "stopping"} onClick={() => void control("stop")}><Square size={17} /></button>
            : <button className="composer-button send" aria-label="发送消息给 Claude" disabled={!controlEnabled || actionBusy || !drafts[`claude:${selectedId}`]?.trim()}>{actionBusy ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}</button>}</div>
        </form><div className="chat-bottom" ref={bottom} />
      </>}
    </section>
  </div>;
}

function ApprovalCard({ approval, busy, onDecision }: { approval: ClaudeApproval; busy: boolean; onDecision: (allow: boolean, answers?: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const input = approval.input as { questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }> } | null;
  const questions = approval.tool === "AskUserQuestion" && Array.isArray(input?.questions) ? input.questions : [];
  return <article className="approval-panel claude-approval">
    <div className="approval-copy"><strong>{questions.length ? "Claude 需要你的回答" : `Claude 请求执行：${approval.tool}`}</strong>
      {questions.length ? questions.map(question => <label className="claude-question" key={question.question}><span>{question.question}</span>
        <small>{question.options?.map(option => `${option.label}${option.description ? `：${option.description}` : ""}`).join("；")}</small>
        <input maxLength={2000} placeholder="输入选择或直接回答" value={answers[question.question] || ""} onChange={event => setAnswers(current => ({ ...current, [question.question]: event.target.value }))} /></label>)
        : <code>{JSON.stringify(approval.input, null, 2)}</code>}
    </div>
    <div className="approval-actions"><button className="approval-button decline" disabled={busy} onClick={() => onDecision(false)}>拒绝</button><button className="approval-button accept" disabled={busy || questions.some(question => !answers[question.question]?.trim())} onClick={() => onDecision(true, questions.length ? answers : undefined)}>{questions.length ? "提交回答" : "允许本次"}</button></div>
  </article>;
}

function hasConversation(message: { items: unknown[] }): boolean {
  return message.items.some(item => { const role = itemRole(item); return role === "user" || role === "agent"; });
}

function statusText(status: string): string {
  return ({ starting: "正在启动", running: "运行中", approval: "等待审批", stopping: "正在停止", completed: "已完成", stopped: "已停止", failed: "执行失败", external: "电脑端占用", unknown: "未接管" } as Record<string, string>)[status] || "状态未知";
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Claude 历史读取失败，请重试";
}
