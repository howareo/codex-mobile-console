import { AppServerClient } from "../protocol/app-server-client.js";

const client = new AppServerClient({ url: process.argv[2] ?? "ws://127.0.0.1:4500", timeoutMs: 3000, autoReconnect: false,
  clientInfo: { name: "codex-mobile-idle-check", title: "Idle Check", version: "0.1.0" } });
const deadline = setTimeout(() => { client.close(); process.exit(2); }, 8000);
try {
  await client.connect();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.listLoadedThreads(cursor);
    for (const id of page.data) {
      const { thread } = await client.readThreadMetadata(id);
      const status = (thread as unknown as { status?: { type?: string } }).status;
      if (status?.type !== "idle") throw new Error("loaded task is busy or its status is unknown");
    }
    cursor = page.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("repeated cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  console.log(JSON.stringify({ idle: true }));
} catch {
  console.log(JSON.stringify({ idle: false }));
  process.exitCode = 2;
} finally { clearTimeout(deadline); client.close(); }
