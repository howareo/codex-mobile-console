import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface GatewayConfig {
  appServerUrl: string;
  pairingSecret: string;
  host: string;
  port: number;
  tls?: { cert: string; key: string };
  staticRoot: string;
  logFile: string | null;
  sessionTtlMs: number;
  sessionStoreFile: string | null;
  imageUploadRoot?: string | null;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_TTL_MS = 72 * 60 * 60 * 1000;

export async function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  const appServerUrl = env.CODEX_MOBILE_APP_SERVER_URL?.trim();
  if (!appServerUrl) throw new Error("CODEX_MOBILE_APP_SERVER_URL is required");
  assertLoopbackAppServer(appServerUrl);
  const secretPath = env.CODEX_MOBILE_PAIRING_SECRET_FILE?.trim();
  if (!secretPath) throw new Error("CODEX_MOBILE_PAIRING_SECRET_FILE is required");
  const pairingSecret = (await readFile(secretPath, "utf8")).trim();
  if (pairingSecret.length < 32) throw new Error("pairing secret must be at least 32 characters");
  const host = env.CODEX_MOBILE_HOST?.trim() || "127.0.0.1";
  if (["0.0.0.0", "::", "*", ""].includes(host)) throw new Error("gateway host must not be an all-interface bind");
  const port = parsePort(env.CODEX_MOBILE_PORT ?? "4174");
  const cert = env.CODEX_MOBILE_TLS_CERT?.trim();
  const key = env.CODEX_MOBILE_TLS_KEY?.trim();
  if ((cert && !key) || (!cert && key)) throw new Error("TLS cert and key must be configured together");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && (!cert || !key)) {
    throw new Error("non-loopback gateway binds require TLS");
  }
  const result: GatewayConfig = {
    appServerUrl,
    pairingSecret,
    host,
    port,
    staticRoot: resolve(env.CODEX_MOBILE_STATIC_ROOT?.trim() || "dist/web"),
    logFile: resolve(env.CODEX_MOBILE_LOG_FILE?.trim() || ".runtime/gateway.ndjson"),
    sessionTtlMs: sessionTtlMs(env.CODEX_MOBILE_SESSION_TTL_MS),
    sessionStoreFile: resolve(env.CODEX_MOBILE_SESSION_STORE_FILE?.trim() || ".runtime/private/sessions.json"),
    imageUploadRoot: resolve(env.CODEX_MOBILE_IMAGE_UPLOAD_ROOT?.trim() || ".runtime/private/uploads/images")
  };
  if (cert && key) result.tls = { cert, key };
  return result;
}

function sessionTtlMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_SESSION_TTL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("CODEX_MOBILE_SESSION_TTL_MS must be a positive number");
  return Math.min(MAX_SESSION_TTL_MS, Math.max(MIN_SESSION_TTL_MS, Math.floor(parsed)));
}

export function assertLoopbackAppServer(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("app-server URL must use WebSocket transport");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("raw app-server must remain loopback-only");
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid gateway port: ${value}`);
  return port;
}
