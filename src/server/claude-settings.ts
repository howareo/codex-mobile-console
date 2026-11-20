import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ClaudeEffort, ClaudeRunOptions, ClaudeSettings } from "../shared/claude.js";
import { ClaudeReadError, safeText } from "./claude-history.js";

export const claudeEfforts: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const claudeOptionsSchema = z.object({ model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: z.enum(["default", "bypassPermissions"]).optional() }).strict();

export async function localClaudeSettings(cwd: string): Promise<ClaudeSettings> {
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const directories: string[] = [];
  for (let path = resolve(cwd); ; path = dirname(path)) {
    directories.unshift(path);
    if (dirname(path) === path) break;
  }
  const paths = [join(configRoot, "settings.json"), ...directories.flatMap(path => [join(path, ".claude", "settings.json"), join(path, ".claude", "settings.local.json")])];
  const effective: ClaudeRunOptions = {};
  const env: Record<string, string> = {};
  for (const path of paths) {
    let settings;
    try { settings = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ClaudeReadError(503, "Claude 设置正在更新或格式有误，请稍后重试");
    }
    if (typeof settings.model === "string") effective.model = safeText(settings.model, 200);
    if (claudeEfforts.includes(settings.effortLevel)) effective.effort = settings.effortLevel;
    const mode = settings.permissions?.defaultMode;
    if (mode === "default" || mode === "bypassPermissions") effective.permissionMode = mode;
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_EFFORT_LEVEL"]) {
      if (typeof settings.env?.[key] === "string") env[key] = settings.env[key];
    }
  }
  for (const key of Object.keys(env)) if (process.env[key]) env[key] = process.env[key]!;
  if (process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
  if (env.ANTHROPIC_MODEL) effective.model = safeText(env.ANTHROPIC_MODEL, 200);
  const effort = process.env.CLAUDE_CODE_EFFORT_LEVEL || env.CLAUDE_CODE_EFFORT_LEVEL;
  if (claudeEfforts.includes(effort as ClaudeEffort)) effective.effort = effort as ClaudeEffort;
  const models = new Map<string, { value: string; displayName: string }>();
  for (const [alias, key] of [["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"], ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"], ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]]) {
    const value = safeText(process.env[key!] || env[key!] || alias, 200);
    models.set(value, { value, displayName: value });
  }
  if (effective.model) models.set(effective.model, { value: effective.model, displayName: effective.model });
  return { effective, models: [...models.values()] };
}
