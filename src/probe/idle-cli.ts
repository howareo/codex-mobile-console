import { AppServerClient } from "../protocol/app-server-client.js";
import { threadStatus } from "../shared/types.js";

const url = process.argv[2] ?? "ws://127.0.0.1:4500";
const client = new AppServerClient({
  url,
  timeoutMs: 3000,
  autoReconnect: false,
  clientInfo: { name: "codex-mobile-idle-check", title: "Idle Check", version: "0.1.0" }
});
const deadline = setTimeout(() => {
  client.close();
  process.exit(2);
}, 8000);

function write(result: unknown, code: number): void {
  console.log(JSON.stringify(result));
  process.exitCode = code;
}

try {
  await client.connect();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let loaded = 0;
  let busyCount = 0;
  const busy: Array<{ id: string; status: string }> = [];
  const unknown: string[] = [];
  do {
    const page = await client.listLoadedThreads(cursor);
    for (const id of page.data) {
      loaded += 1;
      const { thread } = await client.readThreadMetadata(id);
      const status = threadStatus((thread as { status?: unknown }).status);
      if (status === "idle") continue;
      if (!status) {
        if (unknown.length < 8) unknown.push(id);
        continue;
      }
      busyCount += 1;
      if (busy.length < 8) busy.push({ id, status });
    }
    cursor = page.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("repeated cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const idle = busyCount === 0 && unknown.length === 0;
  write({ idle, loaded, busyCount, unknownCount: unknown.length, busy, unknown }, idle ? 0 : 2);
} catch (error) {
  write({
    idle: false,
    loaded: 0,
    busyCount: 0,
    unknownCount: 0,
    busy: [],
    unknown: [],
    error: error instanceof Error ? error.message : String(error)
  }, 2);
} finally {
  clearTimeout(deadline);
  client.close();
}
