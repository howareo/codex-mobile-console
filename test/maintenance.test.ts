import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isCodexMaintenanceRequest, maintenanceActive } from "../src/server/maintenance.js";
import { holdMaintenance } from "./maintenance-owner.js";

it.runIf(process.platform === "win32")("releases maintenance after forced exit, including PID reuse and broken markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mobile-maintenance-"));
  const path = join(root, "marker.json");
  let release: (() => Promise<void>) | undefined;
  try {
    expect(maintenanceActive(path)).toBe(false);
    release = await holdMaintenance(path);
    expect(maintenanceActive(path)).toBe(true);
    await release(); release = undefined;
    expect(maintenanceActive(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 2, ownerPid: process.pid, nonce: "reused-live-pid" }));
    expect(maintenanceActive(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ ownerPid: process.pid, nonce: "legacy" }));
    expect(maintenanceActive(path)).toBe(false);
    writeFileSync(path, "{");
    expect(maintenanceActive(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ nonce: "old-orphan" }));
    expect(maintenanceActive(path)).toBe(false);
  } finally { await release?.(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

it("isolates Codex maintenance from the page, Claude, authentication and diagnostics", () => {
  for (const path of ["/api/threads", "/api/threads/t/turns", "/api/models?x=1", "/api/events", "/api/approvals/a", "/api/diagnostics/loaded-tasks"]) {
    expect(isCodexMaintenanceRequest(path)).toBe(true);
  }
  for (const path of ["/", "/assets/app.js", "/api/auth/session", "/api/claude/events", "/api/claude/sessions/x/messages", "/api/healthz", "/api/diagnostics/status"]) {
    expect(isCodexMaintenanceRequest(path)).toBe(false);
  }
});
