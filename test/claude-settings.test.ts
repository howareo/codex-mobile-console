import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeOptionsSchema, localClaudeSettings } from "../src/server/claude-settings.js";
import { projectClaudePage } from "../src/server/claude-history.js";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

afterEach(() => vi.unstubAllEnvs());
describe("Claude session options", () => {
  it("inherits the latest main-session model rather than a child agent's model", () => {
    const messages = [
      { type: "assistant", uuid: "first", parent_tool_use_id: null, message: { model: "session-model", content: [{ type: "text", text: "main" }] } },
      { type: "assistant", uuid: "child", parent_tool_use_id: "tool", message: { model: "child-model", content: [{ type: "text", text: "child" }] } },
      { type: "assistant", uuid: "error", parent_tool_use_id: null, message: { model: "<synthetic>", content: [{ type: "text", text: "API error" }] } }
    ] as SessionMessage[];
    expect(projectClaudePage(messages).settings).toEqual({ model: "session-model" });
    expect(projectClaudePage(messages).messages.map(message => message.id)).not.toContain("child");
  });
  it("reads layered local defaults and model aliases without returning credentials or writing configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-settings-test-"));
    const config = join(root, "config"); const cwd = join(root, "project");
    try {
      await mkdir(config); await mkdir(join(cwd, ".claude"), { recursive: true });
      vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("ANTHROPIC_MODEL", ""); vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "");
      await writeFile(join(config, "settings.json"), JSON.stringify({ effortLevel: "high", permissions: { defaultMode: "bypassPermissions" }, env: { ANTHROPIC_AUTH_TOKEN: "DO_NOT_EXPOSE", ANTHROPIC_MODEL: "custom-opus" } }));
      await writeFile(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ effortLevel: "low", permissions: { defaultMode: "default" }, env: { ANTHROPIC_MODEL: "project-model" } }));
      const settings = await localClaudeSettings(cwd);
      expect(settings.effective).toMatchObject({ model: "project-model", effort: "low", permissionMode: "default" });
      expect(settings.models.some(model => model.value === "project-model")).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("DO_NOT_EXPOSE");
      await writeFile(join(cwd, ".claude", "settings.local.json"), "{unfinished");
      await expect(localClaudeSettings(cwd)).rejects.toMatchObject({ statusCode: 503 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects unknown options and distinguishes bypass from silently denying tools", () => {
    expect(claudeOptionsSchema.parse({ model: "custom/model", effort: "xhigh", permissionMode: "bypassPermissions" })).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(claudeOptionsSchema.safeParse({ permissionMode: "dontAsk" }).success).toBe(false);
    expect(claudeOptionsSchema.safeParse({ apiKey: "secret" }).success).toBe(false);
    expect(claudeOptionsSchema.safeParse({ effort: "unlimited" }).success).toBe(false);
  });
});
