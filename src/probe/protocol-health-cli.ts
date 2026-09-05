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

const result = await checkAppServerProtocol(url, timeoutMs);
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 2;
