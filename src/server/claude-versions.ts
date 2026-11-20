import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const CLI_VERSION_TIMEOUT_MS = 5000;

export interface ClaudeVersions {
  sdkVersion: string;
  expectedCliVersion: string;
  cliVersion: string | null;
  cliError: string | null;
  match: boolean;
}

export interface ClaudeVersionSource {
  readSdkPackage(): Promise<{ version: string; claudeCodeVersion: string }>;
  readCliVersion(): Promise<string>;
}

export function claudeCliPath(): string {
  return join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
}

const defaultSource: ClaudeVersionSource = {
  async readSdkPackage() {
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    return JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8"));
  },
  async readCliVersion() {
    const { stdout } = await promisify(execFile)(claudeCliPath(), ["--version"], { timeout: CLI_VERSION_TIMEOUT_MS, windowsHide: true });
    return stdout;
  }
};

// The CLI auto-updates while the backend keeps running, so the gateway reads the version once and caches it.
export function createClaudeVersionReporter(source: ClaudeVersionSource = defaultSource): () => Promise<ClaudeVersions> {
  let cached: Promise<ClaudeVersions> | null = null;
  return () => cached ??= (async () => {
    const sdk = await source.readSdkPackage();
    let cliVersion: string | null = null;
    let cliError: string | null = null;
    try {
      const parsed = /^\d+\.\d+\.\d+\S*/.exec((await source.readCliVersion()).trim());
      if (parsed) cliVersion = parsed[0];
      else cliError = "unrecognized --version output";
    } catch (error) {
      cliError = error instanceof Error ? error.message : String(error);
    }
    return { sdkVersion: sdk.version, expectedCliVersion: sdk.claudeCodeVersion, cliVersion, cliError, match: cliVersion === sdk.claudeCodeVersion };
  })();
}
