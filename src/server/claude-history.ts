import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeHistoryPage } from "../shared/claude.js";

export class ClaudeReadError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export type ClaudeHistorySlice = Pick<ClaudeHistoryPage, "messages" | "olderCursor" | "settings">;

export function projectClaudePage(messages: SessionMessage[], cursor?: string): ClaudeHistorySlice {
  messages = messages.filter(message => !message.parent_tool_use_id);
  let end = messages.length;
  if (cursor) {
    const anchor = messages.findIndex(message => message.uuid === cursor);
    if (anchor < 0) throw new ClaudeReadError(409, "会话历史已变化，请重新打开会话");
    end = anchor;
  }
  const start = Math.max(0, end - 30);
  return {
    messages: messages.slice(start, end).map(projectClaudeMessage),
    olderCursor: start > 0 ? messages[start]!.uuid : null,
    settings: (() => {
      const latest = messages.findLast(message => {
        const model = object(message.message).model;
        return message.type === "assistant" && !message.parent_tool_use_id && typeof model === "string" && model.length > 0 && !model.startsWith("<");
      });
      return latest ? { model: safeText(object(latest.message).model, 200) } : {};
    })()
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function safeText(value: unknown, limit = 6000): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{16,}/g, "[密钥已隐藏]");
  return text.length > limit ? `${text.slice(0, limit)}\n[内容较长，已截取；本机原记录保持完整]` : text;
}

export function safeInput(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[已折叠]";
  if (typeof value === "string") return safeText(value, 1500);
  if (Array.isArray(value)) return value.slice(0, 12).map(item => safeInput(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20)
    .map(([key, entry]) => [key, /token|secret|password|authorization|api.?key/i.test(key) ? "[已隐藏]" : safeInput(entry, depth + 1)]));
  return value;
}

export function projectClaudeMessage(message: SessionMessage): { id: string; items: unknown[] } {
  const content = object(message.message).content;
  const metadata = object(message);
  const origin = object(metadata.origin).kind;
  const injected = message.type === "user" && (typeof origin === "string" && origin !== "human"
    || metadata.is_meta === true || metadata.isSynthetic === true);
  const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const items: Record<string, unknown>[] = [];
  let remaining = 16_000;
  for (const [index, value] of blocks.slice(0, 40).entries()) {
    const block = object(value);
    const id = `${message.uuid}:${index}`;
    const limited = (value: unknown): string => safeText(value, Math.min(6000, Math.max(0, remaining)));
    let item: Record<string, unknown>;
    if (block.type === "text") {
      // Older transcripts can lack origin metadata on background task notifications.
      const notification = message.type === "user" && origin !== "human" && typeof block.text === "string"
        && /^\s*<task-notification>[\s\S]*<\/task-notification>/.test(block.text);
      item = injected || notification
        ? { id, type: "dynamicToolCall", tool: origin === "peer" ? "Claude 代理消息" : "Claude 系统通知", status: "", result: limited(block.text) }
        : { id, type: message.type === "user" ? "userMessage" : "agentMessage", text: limited(block.text) };
    } else if (block.type === "thinking") {
      item = { id, type: "reasoning", summary: [limited(block.thinking)] };
    } else if (block.type === "tool_use") {
      item = { id, type: "dynamicToolCall", tool: safeText(block.name, 160), toolUseId: safeText(block.id, 160), status: "", result: limited(JSON.stringify(safeInput(block.input))) };
    } else if (block.type === "tool_result") {
      const output = typeof block.content === "string" ? block.content : Array.isArray(block.content)
        ? block.content.map(entry => safeText(object(entry).text)).filter(Boolean).join("\n") : "";
      item = { id, type: "dynamicToolCall", tool: "工具结果", toolUseId: safeText(block.tool_use_id, 160),
        status: block.is_error ? "failed" : "completed", result: limited(output) };
    } else {
      item = { id, type: "unknown", text: block.type === "redacted_thinking" ? "此段思考未公开"
        : block.type === "image" ? "此条记录包含图片，Claude 历史图片显示尚未接入" : `尚未支持的 Claude 内容类型：${safeText(block.type, 80) || "未知"}` };
    }
    remaining -= JSON.stringify(item).length;
    items.push(item);
    if (remaining <= 0) { items.push({ id: `${id}:limit`, type: "unknown", text: "该条消息较长，已截取；本机原记录保持完整" }); break; }
  }
  if (items.length === 0) items.push({ id: message.uuid, type: "unknown", text: "此条记录没有可显示的内容" });
  if (blocks.length > 40) items.push({ id: `${message.uuid}:blocks-limit`, type: "unknown", text: "此条记录内容块较多，已截取；本机原记录保持完整" });
  return { id: message.uuid, items };
}
