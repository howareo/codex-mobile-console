import { AppServerClient } from "../protocol/app-server-client.js";

export interface ProtocolHealthResult {
  ok: boolean;
  url: string;
  initialize: boolean;
  threadList: boolean;
  codexHome: string | null;
  platformOs: string | null;
  threadCount: number | null;
  durationMs: number;
  error: string | null;
}

export async function checkAppServerProtocol(url: string, timeoutMs = 8_000): Promise<ProtocolHealthResult> {
  const startedAt = Date.now();
  const client = new AppServerClient({
    url,
    timeoutMs,
    autoReconnect: false,
    clientInfo: { name: "codex-mobile-console-health", title: "Codex Mobile Protocol Check", version: "0.1.0" }
  });
  let initialize = false;
  try {
    const initialized = await client.connect();
    initialize = true;
    const threads = await client.listThreads();
    return {
      ok: true,
      url,
      initialize,
      threadList: true,
      codexHome: initialized.codexHome ?? null,
      platformOs: initialized.platformOs ?? null,
      threadCount: threads.data.length,
      durationMs: Date.now() - startedAt,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      url,
      initialize,
      threadList: false,
      codexHome: null,
      platformOs: null,
      threadCount: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    client.close();
  }
}
