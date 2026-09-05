export function errorDetail(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const detail = raw
    .replace(/^\d{3}\s*:\s*/, "")
    .replace(/(pairing(?:[-_ ]?(?:secret|token))?|token|secret|authorization|api[-_]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[已隐藏]")
    .trim();
  return detail.length > 1_500 ? `${detail.slice(0, 1_500)}\n…（错误信息已截断）` : detail;
}

export function turnErrorText(turn: unknown): string {
  if (typeof turn !== "object" || turn === null || Array.isArray(turn)) return "";
  const error = (turn as Record<string, unknown>).error;
  if (typeof error === "string") return errorDetail(error);
  if (typeof error !== "object" || error === null || Array.isArray(error)) return "";
  const value = error as Record<string, unknown>;
  const message = typeof value.message === "string" ? value.message : "";
  const additional = typeof value.additionalDetails === "string"
    ? value.additionalDetails
    : value.additionalDetails == null
      ? ""
      : JSON.stringify(value.additionalDetails);
  return errorDetail([message, additional].filter(Boolean).join("\n"));
}

function withRetry(detail: string, fallback: string): string {
  return detail ? `${detail}；${fallback}` : fallback;
}

export function sendErrorText(cause: unknown): string {
  const message = errorDetail(cause);
  if (/409|already in progress/i.test(message)) return "任务正在处理上一条操作，消息已保留，请稍后重试";
  if (/thread not found/i.test(message)) return withRetry(`任务加载失败：${message}`, "消息已保留，请重试");
  if (/timed out|timeout/i.test(message)) return withRetry("响应超时", "消息已保留，请重试");
  if (/401|unauthorized/i.test(message)) return "登录已失效，请重新输入配对密钥";
  if (/network|failed to fetch/i.test(message)) return "网络连接中断，消息已保留，请重试";
  return withRetry(message, "发送失败，消息已保留，请重试");
}

export function interruptErrorText(cause: unknown): string {
  const message = errorDetail(cause);
  if (/timed out|timeout/i.test(message)) return withRetry("停止请求超时", "请确认任务状态后重试");
  if (/401|unauthorized/i.test(message)) return "登录已失效，请重新输入配对密钥";
  if (/network|failed to fetch/i.test(message)) return "网络连接中断，停止状态尚未确认";
  return withRetry(message, "停止失败，请确认任务状态后重试");
}
