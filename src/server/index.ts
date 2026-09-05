import { AppServerClient } from "../protocol/app-server-client.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayApp } from "./app.js";
import { GatewayLogger } from "./diagnostics.js";

const config = await loadGatewayConfig();
const logger = new GatewayLogger(config.logFile);
const upstream = new AppServerClient({
  url: config.appServerUrl,
  clientInfo: { name: "codex-mobile-console-gateway", title: "Codex Mobile Console Gateway", version: "0.1.0" },
  capabilities: { experimentalApi: true },
  autoReconnect: true
});
logger.info("gateway.starting", { host: config.host, port: config.port, tls: Boolean(config.tls) });
try {
  await upstream.connect();
  logger.info("upstream.connected", { platformOs: upstream.initializeResult?.platformOs, userAgent: upstream.initializeResult?.userAgent });
} catch (error) {
  logger.error("upstream.connect_failed", { error });
  await logger.flush();
  throw error;
}
const app = await createGatewayApp(config, upstream, logger);
await app.listen({ host: config.host, port: config.port });
logger.info("gateway.listening", { host: config.host, port: config.port, tls: Boolean(config.tls) });
await logger.flush();
console.log(`codex-mobile-console gateway listening on ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);

const shutdown = async () => {
  upstream.close();
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
