import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/protocol/app-server-client.js";
import { createGatewayApp } from "../src/server/app.js";
import { createClaudeVersionReporter, type ClaudeVersionSource } from "../src/server/claude-versions.js";
import type { GatewayConfig } from "../src/server/config.js";

const sdkPackage = { version: "0.3.316", claudeCodeVersion: "2.1.316" };
const source = (readCliVersion: () => Promise<string>): ClaudeVersionSource => ({ readSdkPackage: async () => sdkPackage, readCliVersion });

describe("claude version reporter", () => {
  it("reports match when the local CLI equals the SDK's expected version", async () => {
    const report = await createClaudeVersionReporter(source(async () => "2.1.316 (Claude Code)\n"))();
    expect(report).toEqual({ sdkVersion: "0.3.316", expectedCliVersion: "2.1.316", cliVersion: "2.1.316", cliError: null, match: true });
  });

  it("reports drift when the auto-updated CLI is newer", async () => {
    const report = await createClaudeVersionReporter(source(async () => "2.1.322 (Claude Code)"))();
    expect(report).toMatchObject({ cliVersion: "2.1.322", cliError: null, match: false });
  });

  it("turns a failed CLI probe into null plus a reason", async () => {
    const report = await createClaudeVersionReporter(source(async () => { throw new Error("spawn ENOENT"); }))();
    expect(report).toMatchObject({ cliVersion: null, cliError: "spawn ENOENT", match: false });
    expect(await createClaudeVersionReporter(source(async () => "garbage"))()).toMatchObject({ cliVersion: null, cliError: "unrecognized --version output", match: false });
  });

  it("probes the CLI only once", async () => {
    const readCliVersion = vi.fn(async () => "2.1.316 (Claude Code)");
    const report = createClaudeVersionReporter(source(readCliVersion));
    await Promise.all([report(), report()]);
    await report();
    expect(readCliVersion).toHaveBeenCalledTimes(1);
  });
});

describe("gateway diagnostics status", () => {
  let app: Awaited<ReturnType<typeof createGatewayApp>> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("exposes the claude versions behind the session gate", async () => {
    const secret = "v".repeat(32);
    const config: GatewayConfig = { appServerUrl: "ws://127.0.0.1:4500", pairingSecret: secret, host: "127.0.0.1", port: 4174, staticRoot: "C:\\missing-codex-mobile-static-root", logFile: null, sessionTtlMs: 60_000, sessionStoreFile: null };
    app = await createGatewayApp(config, new EventEmitter() as unknown as AppServerClient, undefined, createClaudeVersionReporter(source(async () => "2.1.322 (Claude Code)")));
    expect((await app.inject({ method: "GET", url: "/api/diagnostics/status" })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const status = await app.inject({ method: "GET", url: "/api/diagnostics/status", headers: { cookie } });
    expect(status.json().claude).toEqual({ sdkVersion: "0.3.316", expectedCliVersion: "2.1.316", cliVersion: "2.1.322", cliError: null, match: false });
  });
});
