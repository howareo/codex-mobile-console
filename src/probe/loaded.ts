import { AppServerClient } from "../protocol/app-server-client.js";

function parseUrl(argv: string[]): string {
  const index = argv.indexOf("--url");
  const positional = argv.find(value => !value.startsWith("--"));
  const value = index >= 0 ? argv[index + 1] : positional ?? process.env.CODEX_MOBILE_APP_SERVER_URL;
  if (!value || value.startsWith("--")) {
    throw new Error("usage: npm run loaded-threads -- ws://127.0.0.1:4500");
  }
  return value;
}

const client = new AppServerClient({
  url: parseUrl(process.argv.slice(2)),
  clientInfo: { name: "codex-mobile-resource-audit", title: "Codex Mobile Resource Audit", version: "0.1.0" },
  capabilities: { experimentalApi: false }
});

try {
  await client.connect();
  const threadIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.listLoadedThreads(cursor);
    threadIds.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  console.log(JSON.stringify({ count: threadIds.length, threadIds }, null, 2));
} finally {
  client.close();
}
