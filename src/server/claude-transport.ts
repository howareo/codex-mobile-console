import { createHmac } from "node:crypto";

export const CLAUDE_BACKEND_URL = "http://127.0.0.1:4600";
export function claudeBackendKey(pairingSecret: string): string {
  return createHmac("sha256", pairingSecret).update("codex-mobile-claude-backend-v1").digest("hex");
}
