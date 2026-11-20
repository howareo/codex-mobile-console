import React, { useEffect, useRef, useState } from "react";
import type { ToolDetailPage } from "../../src/shared/types";

export type DetailRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function ToolDetailText({ kind, text }: { kind: ToolDetailPage["kind"]; text: string }) {
  return <pre className={`tool-full-text ${kind}`} tabIndex={0} role="region" aria-label={kind === "diff" ? "文件差异，可滚动查看" : "命令输出，可滚动查看"}>{kind === "output" ? text : text.split("\n").map((line, index, lines) =>
    <span key={index} className={line.startsWith("文件：") || line.startsWith("---") || line.startsWith("+++") ? "diff-heading" : line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : undefined}>{line}{index < lines.length - 1 ? "\n" : ""}</span>)}</pre>;
}

export function ToolDetails({ path, kind, request }: { path: string; kind: ToolDetailPage["kind"]; request: DetailRequest }) {
  const [pages, setPages] = useState<ToolDetailPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async (reset = false) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    const last = reset ? undefined : pages.at(-1);
    const query = last ? `offset=${last.nextOffset}&revision=${last.revision}` : "offset=0";
    try {
      const page = await request<ToolDetailPage>(`${path}${path.includes("?") ? "&" : "?"}${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setPages(current => reset ? [page] : [...current, page]);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "详情读取失败，请重试");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const last = pages.at(-1);
  return <section className="tool-full-details" aria-busy={busy} aria-label={kind === "diff" ? "完整文件差异" : "完整命令输出"}>
    {last && <><ToolDetailText kind={last.kind} text={pages.map(page => page.text).join("")} /><small>已加载 {(last.offset + last.text.length).toLocaleString()} / {last.totalCharacters.toLocaleString()} 字符{last.totalCharacters === 0 ? " · app-server 未返回输出" : ""}</small></>}
    {error && <span className="tool-detail-error" role="alert">{error}</span>}
    <div className="tool-detail-actions">{(!last || last.nextOffset !== null) && <button type="button" className="tool-more" disabled={busy} onClick={() => void load()}>{busy ? "正在读取…" : last ? "加载更多详情" : kind === "diff" ? "查看完整差异" : "查看完整输出"}</button>}
      {(last || error) && <button type="button" className="tool-more" disabled={busy} onClick={() => void load(true)}>{busy && last ? "正在读取…" : "刷新详情"}</button>}
    </div>
  </section>;
}
