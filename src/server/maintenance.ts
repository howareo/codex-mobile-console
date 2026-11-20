import { closeSync, openSync, readFileSync } from "node:fs";

// Windows releases FileShare.Read handles even after a forced process exit.
// A PID can be reused; only the reload script's live write lock closes admission.
export function maintenanceActive(path: string | null): boolean {
  if (!path) return false;
  try {
    const fd = openSync(path, "r+");
    closeSync(fd);
    return false;
  } catch (error) {
    // Only a sharing violation proves a live writer. EACCES/EPERM come from
    // ACLs, read-only attributes or pending deletes and must not fall back to
    // the PID-only check that a reused PID can satisfy.
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") return false;
  }
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (marker.version !== 2 || typeof marker.nonce !== "string" || !marker.nonce ||
        !Number.isSafeInteger(marker.ownerPid) || marker.ownerPid <= 0) return false;
    try { process.kill(marker.ownerPid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  } catch {
    // Invalid/partially published markers cannot acknowledge a reload window.
    return false;
  }
}

export function isCodexMaintenanceRequest(url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return /^\/api\/(threads|models|approvals|events)(\/|$)/.test(path) || path === "/api/diagnostics/loaded-tasks";
}
