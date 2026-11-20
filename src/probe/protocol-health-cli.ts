import { checkAppServerProtocol } from "./protocol-health.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = readArg("--url") ?? process.env.CODEX_MOBILE_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const timeoutText = readArg("--timeout-ms") ?? "8000";
const timeoutMs = Number.parseInt(timeoutText, 10);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
  throw new Error("--timeout-ms must be between 1000 and 60000");
}

const hardTimer = setTimeout(() => {
  console.log(JSON.stringify({
    ok: false,
    url,
    initialize: false,
    threadList: false,
    codexHome: null,
    platformOs: null,
    threadCount: null,
    durationMs: timeoutMs,
    error: `protocol check exceeded ${timeoutMs}ms`
  }));
  process.exit(2);
}, timeoutMs + 1_000);
hardTimer.unref?.();

const result = await checkAppServerProtocol(url, timeoutMs);
clearTimeout(hardTimer);
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 2;
