import type {
  AppServerFrame
} from "../protocol/app-server-client.js";
import type {
  DesktopThreadSnapshot,
  ThreadComparison,
  ThreadSummary
} from "../shared/types.js";
import { threadLabel, threadStatus } from "../shared/types.js";

export function compareThreads(
  desktopThreads: DesktopThreadSnapshot[],
  appServerThreads: ThreadSummary[]
): ThreadComparison {
  const desktop = new Map(desktopThreads.map(thread => [thread.id, thread]));
  const server = new Map(appServerThreads.map(thread => [thread.id, thread]));
  const missing = [...desktop.keys()].filter(id => !server.has(id)).sort();
  const extra = [...server.keys()].filter(id => !desktop.has(id)).sort();
  const mismatches: ThreadComparison["mismatches"] = [];
  for (const [id, desktopThread] of desktop) {
    const serverThread = server.get(id);
    if (!serverThread) continue;
    const desktopTitle = threadLabel(desktopThread);
    if (desktopTitle !== null) compareField(mismatches, id, "title", desktopTitle, threadLabel(serverThread));
    if (desktopThread.cwd !== undefined) compareField(mismatches, id, "cwd", desktopThread.cwd, serverThread.cwd ?? null);
    if (desktopThread.status !== undefined) compareField(mismatches, id, "status", desktopThread.status, threadStatus(serverThread.status));
    if (desktopThread.updatedAt != null && serverThread.updatedAt != null) {
      compareField(mismatches, id, "updatedAt", desktopThread.updatedAt, serverThread.updatedAt);
    }
  }
  return { pass: missing.length === 0 && extra.length === 0 && mismatches.length === 0, missing, extra, mismatches };
}

function compareField(
  mismatches: ThreadComparison["mismatches"],
  id: string,
  field: string,
  desktop: unknown,
  appServer: unknown
): void {
  if (desktop === appServer) return;
  if (desktop == null && appServer == null) return;
  mismatches.push({ id, field, desktop, appServer });
}

export function transcriptIsReadOnly(frames: AppServerFrame[]): boolean {
  return frames.every(frame => {
    if (frame.direction === "notification") return frame.message != null;
    if (frame.direction === "request") {
      const method = (frame.message as { method?: unknown }).method;
      return method === "initialize" || method === "thread/list" || method === "thread/loaded/list" || method === "thread/read" || method === "thread/turns/list" || method === "model/list" || method === "initialized";
    }
    return true;
  });
}
