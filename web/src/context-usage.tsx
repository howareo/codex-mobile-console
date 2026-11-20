import React from "react";
import type { RpcNotification, ThreadContextUsage } from "../../src/shared/types";

export function contextUsageNotification(notification: RpcNotification): { threadId: string; usage: ThreadContextUsage } | null {
  if (notification.method !== "thread/tokenUsage/updated") return null;
  const params = notification.params as { threadId?: unknown; tokenUsage?: { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } } | undefined;
  const threadId = params?.threadId;
  const usedTokens = params?.tokenUsage?.last?.totalTokens;
  const capacity = params?.tokenUsage?.modelContextWindow;
  if (typeof threadId !== "string" || !threadId || typeof usedTokens !== "number" || !Number.isSafeInteger(usedTokens) || usedTokens < 0) return null;
  const modelContextWindow = typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null;
  return { threadId, usage: { usedTokens, modelContextWindow } };
}

export function ContextUsageIndicator({ usage }: { usage?: ThreadContextUsage | null | undefined }) {
  const capacity = usage?.modelContextWindow ?? null;
  const used = usage?.usedTokens ?? null;
  const percent = capacity !== null && used !== null ? Math.round(used * 100 / capacity) : null;
  const tokens = `${used === null ? "未知" : formatTokens(used)} / ${capacity === null ? "未知" : formatTokens(capacity)} tokens`;
  return (
    <details className="context-usage">
      <summary className="context-usage-toggle" aria-label={`上下文窗口 ${percent === null ? "用量未知" : `已用 ${percent}%`}`}>
        <svg className="context-usage-ring" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle className="context-usage-track" cx="10" cy="10" r="7" opacity="0.25" />
          {percent !== null && <circle className="context-usage-arc" cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${Math.min(percent, 100)} 100`} transform="rotate(-90 10 10)" />}
        </svg>
        <span>{percent === null ? "未知" : `${percent}%`}</span>
      </summary>
      <div className="context-usage-panel">
        <strong>上下文窗口</strong>
        <span>{percent === null ? "已用与剩余比例未知" : `已用 ${percent}% · 剩余 ${Math.max(0, 100 - percent)}%`}</span>
        <span title={`${used?.toLocaleString("zh-CN") ?? "未知"} / ${capacity?.toLocaleString("zh-CN") ?? "未知"} tokens`}>{tokens}</span>
      </div>
    </details>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
