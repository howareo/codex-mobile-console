import { readFile } from "node:fs/promises";
import { createClaudeBackend } from "./claude-backend.js";
import { claudeBackendKey } from "./claude-transport.js";
import { ClaudeSessionStore } from "./claude-store.js";
import { resolve } from "node:path";

const secretFile = process.env.CODEX_MOBILE_PAIRING_SECRET_FILE;
if (!secretFile) throw new Error("CODEX_MOBILE_PAIRING_SECRET_FILE is required");
const secret = (await readFile(secretFile, "utf8")).trim();
if (secret.length < 32) throw new Error("pairing secret is too short");
const app = createClaudeBackend(claudeBackendKey(secret), new ClaudeSessionStore(undefined, resolve(".runtime/private/claude-mobile-sessions.json")));
await app.listen({ host: "127.0.0.1", port: 4600 });
console.log(JSON.stringify({ event: "claude.control.listening", host: "127.0.0.1", port: 4600, pid: process.pid }));
const shutdown = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
