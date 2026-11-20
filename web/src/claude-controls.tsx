import React, { useEffect, useState } from "react";
import type { ClaudeEffort, ClaudeRunOptions, ClaudeRunSnapshot, ClaudeSettings } from "../../src/shared/claude";
import { claudeElapsed, claudeTokenTotal } from "./claude-state";
import { ThreadMessages } from "./thread-messages";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const efforts: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const effortNames: Record<ClaudeEffort, string> = { low: "低", medium: "中", high: "高", xhigh: "更高", max: "最大" };
const tokenText = (value: number) => value.toLocaleString("zh-CN");

export function ClaudeSettingsPanel({ id, request, run, options, onChange, enabled }: {
  id: string; request: Request; run?: ClaudeRunSnapshot | undefined; options: ClaudeRunOptions;
  onChange: (options: ClaudeRunOptions) => void; enabled: boolean;
}) {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void request<ClaudeSettings>(`/api/claude/sessions/${id}/settings`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "设置读取失败，请重新打开会话"); });
    return () => controller.abort();
  }, [id, request, enabled]);
  const effective = run?.settings || settings?.effective || {};
  const models = [...new Map([...(settings?.models || []), ...(run?.models || [])].map(model => [model.value, model])).values()];
  for (const value of [options.model, effective.model]) if (value && !models.some(model => model.value === value)) models.push({ value, displayName: value });
  const selected = models.find(model => model.value === (options.model || effective.model));
  const levels = selected?.supportedEffortLevels || efforts;
  const running = run?.finishedAt === null;
  return <details className="claude-settings">
    <summary><span>模型与权限</span><small>{effective.model || "跟随 Claude"} · {effective.effort ? effortNames[effective.effort] : "默认强度"} · {effective.permissionMode === "bypassPermissions" ? "免审批" : effective.permissionMode === "default" ? "逐次审批" : "跟随权限"}</small></summary>
    <div className="composer-settings">
      <label>模型<select aria-label="Claude 模型" disabled={!settings || running} value={options.model || ""} onChange={event => {
        const next = { ...options }; if (event.target.value) next.model = event.target.value; else delete next.model;
        const supported = models.find(model => model.value === (next.model || effective.model))?.supportedEffortLevels;
        if (next.effort && supported && !supported.includes(next.effort)) delete next.effort;
        onChange(next);
      }}><option value="">跟随会话{effective.model ? `（${effective.model}）` : " / CLI 默认"}</option>{models.map(model => <option key={model.value} value={model.value}>{model.displayName}</option>)}</select></label>
      <label>推理强度<select aria-label="Claude 推理强度" disabled={!settings || running || levels.length === 0} value={options.effort || ""} onChange={event => {
        const next = { ...options }; if (event.target.value) next.effort = event.target.value as ClaudeEffort; else delete next.effort; onChange(next);
      }}><option value="">跟随会话{effective.effort ? `（${effortNames[effective.effort]}）` : " / 默认"}</option>{levels.map(level => <option key={level} value={level}>{effortNames[level]}</option>)}</select></label>
      <label>工具权限<select aria-label="Claude 工具权限" disabled={!settings || running} value={options.permissionMode || ""} onChange={event => {
        const next = { ...options }; if (event.target.value) next.permissionMode = event.target.value as ClaudeRunOptions["permissionMode"]; else delete next.permissionMode; onChange(next);
      }}><option value="">跟随会话 / 本机设置</option><option value="bypassPermissions">免审批执行</option><option value="default">逐次审批</option></select></label>
      <small>{running ? "任务运行中，设置在结束后开放修改。" : "设置按会话保留，从下一条消息生效。模型能力及最终档位以 CLI 实际反馈为准。"} 需要你回答的问题仍会显示。</small>
      {error && <small role="alert" className="composer-settings-error">{error}</small>}
      {!enabled && <small>控制服务待更新，暂未开放模型设置。</small>}
    </div>
  </details>;
}

export function ClaudeRunProgress({ run }: { run: ClaudeRunSnapshot }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (run.finishedAt !== null) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [run.requestId, run.finishedAt]);
  const tasks = run.tasks || [];
  return <details className="claude-run-metrics">
    <summary><span>{run.status === "approval" ? "等待确认" : run.finishedAt === null ? "运行中" : run.status === "completed" ? "已完成" : run.status === "failed" ? "执行失败" : "已停止"} <time>{claudeElapsed(run.startedAt, run.finishedAt ?? now)}</time></span>
      <span>{run.usage ? `Token ${tokenText(claudeTokenTotal(run.usage))}` : "Token 统计中"}</span>{tasks.length > 0 && <span>子任务 {tasks.filter(task => task.status === "completed").length}/{tasks.length}</span>}</summary>
    <div className="claude-usage-detail">{run.usage && <><span>输入 {tokenText(run.usage.inputTokens)}</span><span>输出 {tokenText(run.usage.outputTokens)}</span><span>缓存读取 {tokenText(run.usage.cacheReadTokens)}</span><span>缓存写入 {tokenText(run.usage.cacheWriteTokens)}</span></>}<small>随 CLI 用量事件实时更新；尚未上报的 Token 不估算。这里合计已报告的主会话和子任务消息用量，不再叠加子任务卡片数字。</small></div>
  </details>;
}

export function ClaudeTasks({ run }: { run: ClaudeRunSnapshot }) {
  const [now, setNow] = useState(Date.now);
  const running = run.finishedAt === null && run.tasks?.some(task => task.finishedAt === null);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, run.requestId]);
  if (!run.tasks?.length) return null;
  return <section className="claude-tasks" aria-label="Claude 子任务">
    {run.tasks.map(task => <details className={`claude-task ${task.status}`} key={task.id}>
      <summary><span className="claude-task-state">{task.status === "running" ? <LoaderCircle className="spin" size={15} /> : task.status === "failed" ? <CircleAlert size={15} /> : <CircleCheck size={15} />}{task.status === "running" ? "进行中" : task.status === "completed" ? "已完成" : task.status === "failed" ? "失败" : "已停止"}</span><strong>{task.parentId ? "↳ " : ""}{task.description}</strong><time>{claudeElapsed(task.startedAt, task.finishedAt ?? Math.max(task.startedAt, now))}</time></summary>
      <div className="claude-task-body"><small>{task.totalTokens !== undefined ? `${tokenText(task.totalTokens)} Token · ` : ""}{task.toolUses !== undefined ? `${task.toolUses} 次工具调用 · ` : ""}{task.lastTool ? `最近执行：${task.lastTool}` : "等待进度反馈"}</small>
        {task.summary && <p>{task.summary}</p>}<ThreadMessages items={task.messages.flatMap(message => message.items)} active={task.status === "running"} />
      </div>
    </details>)}
  </section>;
}
