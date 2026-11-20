import React, { useEffect, useState } from "react";
import { Brain, ChevronDown, CircleAlert, File as FileIcon, FilePenLine, FolderClosed, Image, ListChecks, LoaderCircle, Search, Terminal, Wrench } from "lucide-react";
import { isConversationItem, itemDetails, itemId, itemImages, itemRecord, itemRole, itemSummary, itemText, itemType, statusClass, statusText, statusValue, toolLabel } from "./thread-items";
import { MarkdownMessage } from "./message-markdown";
import { ToolDetails, type DetailRequest } from "./tool-details";
import { parseAttachmentMessage } from "./file-attachments";

type TurnBlock = { kind: "item"; item: unknown } | { kind: "activity"; items: unknown[] };

export function ThreadMessages({ items, active = false, userTime = null, assistantTime = null, request }: {
  items: unknown[]; active?: boolean; userTime?: string | null; assistantTime?: string | null; request?: DetailRequest | undefined;
}) {
  const blocks = turnBlocks(items);
  const lastAssistantItem = items.findLast(item => itemRole(item) === "agent");
  return <div className="turn-messages">{blocks.map((block, index) => block.kind === "activity"
    ? <ActivityGroup items={block.items} active={active && index === blocks.length - 1} request={request} key={`activity-${itemId(block.items[0], index)}`} />
    : <ThreadItem item={block.item} time={itemRole(block.item) === "user" ? userTime : block.item === lastAssistantItem ? assistantTime : null} request={request} key={itemId(block.item, index)} />)}</div>;
}

function ActivityGroup({ items, active, request }: { items: unknown[]; active: boolean; request?: DetailRequest | undefined }) {
  const itemStates = items.map(item => statusClass(itemRecord(item).status ?? itemRecord(item).state));
  const state = itemStates.includes("failed") ? "failed" : active || itemStates.includes("running") ? "running" : "done";
  const [open, setOpen] = useState(state === "running");
  const detailId = `activity-${itemId(items[0], 0)}`;
  const labels = [...new Set(items.map(toolLabel))];
  const summary = `${labels.slice(0, 3).join("、")}${labels.length > 3 ? ` 等 ${labels.length} 类` : ""}`;
  useEffect(() => {
    if (state === "running") setOpen(true);
    else if (state === "failed") setOpen(false);
  }, [state]);
  return <section className={`activity-group ${state} ${open ? "open" : "collapsed"}`}>
    <button className="activity-summary" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}>
      <span className="activity-icon" aria-hidden="true">{state === "running" ? <LoaderCircle className="spin" size={16} /> : state === "failed" ? <CircleAlert size={16} /> : <Wrench size={16} />}</span>
      <span className="activity-copy"><strong>执行过程</strong><small>{summary}</small></span>
      <span className="activity-count">{items.length} 项</span><ChevronDown className="tool-chevron" size={16} aria-hidden="true" />
    </button>
    {open && <div className="activity-items" id={detailId}>{items.map((item, index) => <ToolCard item={item} thinking={active && index === items.length - 1} request={request} key={itemId(item, index)} />)}</div>}
  </section>;
}

function ThreadItem({ item, time = null, request }: { item: unknown; time?: string | null; request?: DetailRequest | undefined }) {
  const role = itemRole(item);
  if (role === "system") return <div className="system-row"><span>{toolLabel(item)}</span></div>;
  if (isConversationItem(item)) {
    const message = role === "user" ? parseAttachmentMessage(itemText(item)) : { text: itemText(item), attachments: [] };
    const { text, attachments } = message;
    const images = itemImages(item);
    return <div className={`message-row ${role}`}><span className="message-avatar">{role === "user" ? "我" : "C"}</span><div className="message-stack"><div className={`message-bubble ${images.length > 0 ? "has-images" : ""}`}>{images.length > 0 && <div className="message-images">{images.map(image => <a href={image.src} target="_blank" rel="noreferrer" key={image.imageId}><img src={image.src} alt={role === "user" ? "已上传图片" : "Codex 图片"} loading="lazy" /></a>)}</div>}{text && <MarkdownMessage text={text} />}{attachments.length > 0 && <div className="message-attachments">{attachments.map(file => <span className="attachment-chip" key={file.id}>{file.kind === "folder" ? <FolderClosed size={17} /> : <FileIcon size={17} />}<strong title={file.name}>{file.name}</strong></span>)}</div>}{!text && images.length === 0 && attachments.length === 0 && "（空消息）"}</div>{time && <time className="message-time">{time}</time>}</div></div>;
  }
  return <ToolCard item={item} request={request} />;
}

function ToolCard({ item, thinking = false, request }: { item: unknown; thinking?: boolean; request?: DetailRequest | undefined }) {
  const object = itemRecord(item);
  const type = itemType(item);
  const status = object.status ?? object.state ?? (thinking && type === "reasoning" ? "running" : undefined);
  const state = statusClass(status);
  const statusLabel = statusValue(status) ? statusText(status) : null;
  const details = itemDetails(item);
  const detailsUrl = typeof object.detailsUrl === "string" && /^\/api\/threads\/[^/?#]+\/turns\/[^/?#]+\/items\/[^/?#]+\/details(?:\?pageCursor=[^#]*)?$/.test(object.detailsUrl) ? object.detailsUrl : null;
  const [open, setOpen] = useState(state === "running");
  const [showAll, setShowAll] = useState(false);
  const detailId = `item-details-${itemId(item, 0)}`;
  useEffect(() => {
    if (state === "failed") setOpen(false);
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
  return <article className={`tool-card ${state} ${open ? "open" : "collapsed"}${type === "reasoning" ? " kind-thinking" : ""}`}>
    <button className={`tool-card-header ${statusLabel ? "has-status" : ""}`} type="button" aria-expanded={open} aria-controls={detailId} onClick={event => toggle(event.currentTarget)}>
      <span className="tool-icon" aria-hidden="true">{icon}</span>
      <span className="tool-card-copy"><strong>{toolLabel(item)}</strong><span>{itemSummary(item)}</span></span>
      {statusLabel && <span className="tool-card-status">{statusLabel}</span>}
      <ChevronDown className="tool-chevron" size={16} aria-hidden="true" />
    </button>
    {open && <div className="tool-card-details" id={detailId}>
      {visibleDetails.length > 0 ? <div className="tool-detail-lines">{visibleDetails.map((line, index) => <code key={`${itemId(item, 0)}-${index}`}>{line}</code>)}</div> : <span className="tool-empty">暂无详情</span>}
      {details.length > 12 && <button className="tool-more" type="button" onClick={() => setShowAll(value => !value)}>{showAll ? "收起详情" : `展开全部（${details.length} 行）`}</button>}
      {detailsUrl && request && (type === "fileChange" || type === "commandExecution") && <ToolDetails key={detailsUrl} path={detailsUrl} kind={type === "fileChange" ? "diff" : "output"} request={request} />}
      {type === "unknown" && <code className="tool-raw-type">协议事件：{type}</code>}
    </div>}
  </article>;
}

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
