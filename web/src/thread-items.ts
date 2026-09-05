export type ItemRecord = Record<string, unknown>;

const TOOL_LABELS: Record<string, string> = {
  commandExecution: "执行命令",
  fileChange: "修改文件",
  mcpToolCall: "外部工具",
  dynamicToolCall: "动态工具",
  webSearch: "联网搜索",
  plan: "计划",
  collabAgentToolCall: "协作代理",
  subAgentActivity: "子代理",
  imageView: "查看图片",
  imageGeneration: "生成图片",
  sleep: "等待",
  hookPrompt: "钩子提示",
  reasoning: "思考"
};

const SYSTEM_LABELS: Record<string, string> = {
  contextCompaction: "上下文已压缩",
  enteredReviewMode: "进入评审模式",
  exitedReviewMode: "退出评审模式"
};

export function itemRecord(item: unknown): ItemRecord {
  return typeof item === "object" && item !== null && !Array.isArray(item) ? item as ItemRecord : {};
}

export function itemType(item: unknown): string {
  const type = itemRecord(item).type;
  return typeof type === "string" ? type : "unknown";
}

export function itemId(item: unknown, fallback: number): string {
  const id = itemRecord(item).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : `item-${fallback}`;
}

export function itemRole(item: unknown): "user" | "agent" | "tool" | "system" {
  const type = itemType(item);
  if (type.includes("userMessage")) return "user";
  if (type.includes("agentMessage")) return "agent";
  if (SYSTEM_LABELS[type]) return "system";
  return "tool";
}

export function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  const object = itemRecord(value);
  if (typeof object.text === "string") return object.text;
  return "";
}

export function itemText(item: unknown): string {
  const object = itemRecord(item);
  if (typeof object.text === "string") return object.text;
  if (Array.isArray(object.content)) return object.content.map(firstText).filter(Boolean).join("\n");
  if (Array.isArray(object.summary)) return object.summary.map(firstText).filter(Boolean).join("\n");
  return "";
}

export function itemImages(item: unknown): Array<{ imageId: string; src: string }> {
  const content = itemRecord(item).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(value => {
    const input = itemRecord(value);
    if (input.type !== "localImage" || typeof input.path !== "string") return [];
    const imageId = input.path.replaceAll("\\", "/").split("/").at(-1) || "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp|gif)$/i.test(imageId)) return [];
    return [{ imageId, src: `/api/images/${encodeURIComponent(imageId)}` }];
  });
}

// 统一读取 app-server 返回的字符串状态和对象状态。
export function statusValue(value: unknown): string {
  if (typeof value === "string") return value;
  const object = itemRecord(value);
  if (typeof object.type === "string") return object.type;
  return typeof object.status === "string" ? object.status : "";
}

export function statusText(status: unknown): string {
  const value = statusValue(status);
  return ({
    inProgress: "运行中",
    active: "运行中",
    running: "运行中",
    idle: "空闲",
    notLoaded: "未加载",
    completed: "已完成",
    interrupted: "已停止",
    failed: "失败",
    declined: "已拒绝",
    cancelled: "已取消",
    systemError: "系统错误",
    started: "已开始",
    pending: "等待中"
  } as Record<string, string>)[value] || value || "未知";
}

export function statusClass(status: unknown): "running" | "done" | "failed" | "unknown" {
  const value = statusValue(status);
  if (["inProgress", "active", "running", "started"].includes(value)) return "running";
  if (["idle", "completed", "interrupted", "cancelled", "notLoaded"].includes(value)) return "done";
  if (["failed", "declined", "systemError"].includes(value)) return "failed";
  return "unknown";
}

export function toolLabel(item: unknown): string {
  const type = itemType(item);
  if (TOOL_LABELS[type]) {
    if (type === "commandExecution") {
      const action = itemRecord(item).commandActions;
      const actionType = itemRecord(Array.isArray(action) ? action[0] : null).type;
      return ({ read: "读取文件", listFiles: "列出目录", search: "搜索" } as Record<string, string>)[textValue(actionType)] || "执行命令";
    }
    return TOOL_LABELS[type];
  }
  if (SYSTEM_LABELS[type]) return SYSTEM_LABELS[type];
  return "未识别事件";
}

function shortPath(path: string): string {
  const parts = path.replaceAll("/", "\\").split("\\").filter(Boolean);
  return parts.length > 3 ? `…\\${parts.slice(-3).join("\\")}` : path;
}

function changeKind(kind: unknown): string {
  const value = typeof kind === "string" ? kind : textValue(itemRecord(kind).type);
  return ({ add: "新建", delete: "删除", update: "更新" } as Record<string, string>)[value] || "变更";
}

function outputSummary(object: ItemRecord): string {
  const output = textValue(object.aggregatedOutput || object.output || object.result);
  if (!output) return "";
  const firstLine = output.split(/\r?\n/).find(line => line.trim()) || "";
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

export function itemSummary(item: unknown): string {
  const object = itemRecord(item);
  const type = itemType(item);
  if (type === "fileChange") {
    const changes = Array.isArray(object.changes) ? object.changes : [];
    const paths = changes.map(change => shortPath(textValue(itemRecord(change).path))).filter(Boolean);
    return paths.length > 0 ? `${paths.slice(0, 2).join("、")}${paths.length > 2 ? ` 等 ${paths.length} 个文件` : ""}` : "等待文件列表";
  }
  if (type === "commandExecution") return textValue(object.command) || outputSummary(object) || "等待命令结果";
  if (type === "reasoning") {
    const parts = Array.isArray(object.summary) ? object.summary : Array.isArray(object.content) ? object.content : [];
    return parts.length > 0 ? `${parts.length} 段思考` : "已收起思考内容";
  }
  if (type === "mcpToolCall") return [textValue(object.server), textValue(object.tool)].filter(Boolean).join(" / ") || "等待工具结果";
  if (type === "dynamicToolCall") return [textValue(object.namespace), textValue(object.tool)].filter(Boolean).join(" / ") || "等待工具结果";
  if (type === "webSearch") return textValue(object.query) || "等待搜索内容";
  if (type === "plan") return itemText(item) || "查看执行计划";
  if (type === "imageView") return textValue(object.path) || "查看图片结果";
  if (type === "imageGeneration") return textValue(object.savedPath) || statusText(object.status);
  if (type === "sleep") return object.durationMs != null ? `${textValue(object.durationMs)} 毫秒` : "等待中";
  return outputSummary(object) || itemText(item) || "查看详情";
}

export function itemDetails(item: unknown): string[] {
  const object = itemRecord(item);
  const type = itemType(item);
  if (type === "fileChange") {
    const changes = Array.isArray(object.changes) ? object.changes : [];
    return changes.map(change => {
      const value = itemRecord(change);
      const path = shortPath(textValue(value.path)) || "未知路径";
      const diff = textValue(value.diff);
      const lines = diff ? diff.split(/\r?\n/) : [];
      const added = typeof value.added === "number" ? value.added : lines.filter(line => line.startsWith("+") && !line.startsWith("+++ ")).length;
      const removed = typeof value.removed === "number" ? value.removed : lines.filter(line => line.startsWith("-") && !line.startsWith("--- ")).length;
      const stats = added || removed ? ` (+${added}/-${removed})` : "";
      return `${changeKind(value.kind)} ${path}${stats}`;
    });
  }
  if (type === "commandExecution") {
    return [textValue(object.command), textValue(object.cwd) ? `目录：${textValue(object.cwd)}` : "", object.exitCode != null ? `退出码：${textValue(object.exitCode)}` : "", outputSummary(object)].filter(Boolean);
  }
  if (type === "reasoning") {
    const parts = Array.isArray(object.summary) ? object.summary : Array.isArray(object.content) ? object.content : [];
    return parts.map(firstText).filter(Boolean);
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") return [textValue(object.error) ? `错误：${textValue(object.error)}` : "", object.durationMs != null ? `耗时：${textValue(object.durationMs)} 毫秒` : "", textValue(object.result)].filter(Boolean);
  if (type === "webSearch") return [textValue(object.query), typeof object.resultCount === "number" ? `结果：${object.resultCount} 条` : Array.isArray(object.results) ? `结果：${object.results.length} 条` : ""].filter(Boolean);
  const text = itemText(item);
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

export function isSystemItem(item: unknown): boolean {
  return Boolean(SYSTEM_LABELS[itemType(item)]);
}

export function isConversationItem(item: unknown): boolean {
  const role = itemRole(item);
  return role === "user" || role === "agent";
}
