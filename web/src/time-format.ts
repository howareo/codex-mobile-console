export type TimestampValue = number | string | null | undefined;

export function timestampMs(value: TimestampValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatConversationTime(value: TimestampValue, now = Date.now()): string {
  const timestamp = timestampMs(value);
  if (timestamp == null) return "时间未知";
  const date = new Date(timestamp);
  const current = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth() && date.getDate() === current.getDate()
    ? time
    : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

export function formatDurationMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "";
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 1) return "不到1秒";
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}分${pad(remainder)}秒`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return `${hours}小时${pad(minuteRemainder)}分`;
}

export function turnDurationMs(turn: unknown, now = Date.now()): number | null {
  const object = objectValue(turn);
  if (!object) return null;
  if (typeof object.durationMs === "number" && Number.isFinite(object.durationMs) && object.durationMs >= 0) return object.durationMs;
  const startedAt = timestampMs(object.startedAt as TimestampValue);
  if (startedAt == null) return null;
  const completedAt = timestampMs(object.completedAt as TimestampValue);
  const status = typeof object.status === "string" ? object.status : objectValue(object.status)?.type;
  const running = status === "inProgress" || status === "active" || status === "running";
  if (completedAt == null && !running) return null;
  return Math.max(0, (completedAt ?? now) - startedAt);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
