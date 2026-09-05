import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { AppServerClient, type AppServerFrame } from "../protocol/app-server-client.js";
import type { DesktopThreadSnapshot, InitializeResult, ThreadReadResult, ThreadSummary } from "../shared/types.js";
import { compareThreads, transcriptIsReadOnly } from "./compare.js";

export interface ProbeOptions {
  url: string;
  baselinePath: string;
  outDir: string;
  threadId?: string;
  expectedCodexHome?: string;
}

export interface ProbeResult {
  pass: boolean;
  generatedAt: string;
  initialize: InitializeResult;
  list: { pages: number; count: number; nextCursor: string | null };
  read: { threadId: string; turns: number };
  comparison: ReturnType<typeof compareThreads>;
  transcriptReadOnly: boolean;
  errors: string[];
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const baseline = await loadBaseline(options.baselinePath);
  await mkdir(resolve(options.outDir), { recursive: true });
  const transcriptPath = resolve(options.outDir, "transcript.jsonl");
  await writeFile(transcriptPath, "", "utf8");
  const frames: AppServerFrame[] = [];
  const appendFrame = (frame: AppServerFrame) => { frames.push(frame); };
  const client = new AppServerClient({
    url: options.url,
    onFrame: frame => void appendFrame(frame),
    clientInfo: { name: "codex-mobile-console", title: "Codex Mobile Console", version: "0.1.0" }
  });
  const errors: string[] = [];
  let initialize: InitializeResult = {};
  let pages = 0;
  const threads: ThreadSummary[] = [];
  let nextCursor: string | null = null;
  let read: ThreadReadResult = { thread: { id: "", turns: [] } };
  try {
    initialize = await client.connect();
    do {
      const page = await client.listThreads(nextCursor);
      pages += 1;
      threads.push(...page.data);
      nextCursor = page.nextCursor ?? null;
    } while (nextCursor);
    const threadId = options.threadId ?? baseline[0]?.id;
    if (!threadId) throw new Error("no thread id available for thread/read");
    read = await client.readThread(threadId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    client.close();
  }
  const comparison = compareThreads(baseline, threads);
  const expectedHome = options.expectedCodexHome ?? resolve(homedir(), ".codex");
  if (initialize.codexHome !== expectedHome) errors.push(`codexHome mismatch: ${initialize.codexHome ?? "missing"}`);
  if (!read.thread.id) errors.push("thread/read did not return a thread");
  const result: ProbeResult = {
    pass: errors.length === 0 && comparison.pass && transcriptIsReadOnly(frames),
    generatedAt: new Date().toISOString(),
    initialize,
    list: { pages, count: threads.length, nextCursor },
    read: { threadId: read.thread.id, turns: Array.isArray(read.thread.turns) ? read.thread.turns.length : 0 },
    comparison,
    transcriptReadOnly: transcriptIsReadOnly(frames),
    errors
  };
  await writeFile(resolve(options.outDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(transcriptPath, frames.map(frame => `${JSON.stringify({ ...frame, at: result.generatedAt })}\n`).join(""), "utf8");
  await writeFile(resolve(options.outDir, "threads.json"), `${JSON.stringify(threads, null, 2)}\n`, "utf8");
  await writeFile(resolve(options.outDir, "thread-read.json"), `${JSON.stringify(read, null, 2)}\n`, "utf8");
  return result;
}

async function loadBaseline(path: string): Promise<DesktopThreadSnapshot[]> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (Array.isArray(parsed)) return parsed as DesktopThreadSnapshot[];
  if (typeof parsed === "object" && parsed !== null && "threads" in parsed && Array.isArray(parsed.threads)) {
    return parsed.threads as DesktopThreadSnapshot[];
  }
  throw new Error("desktop baseline must be an array or { threads: [] }");
}

export function parseProbeArgs(argv: string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const url = values.get("url") ?? process.env.CODEX_MOBILE_APP_SERVER_URL;
  const baselinePath = values.get("baseline");
  const outDir = values.get("out") ?? `evidence/phase1/${new Date().toISOString().replaceAll(":", "-")}`;
  if (!url || !baselinePath) throw new Error("usage: npm run probe -- --url URL --baseline PATH [--out DIR] [--thread ID]");
  const options: ProbeOptions = { url, baselinePath, outDir };
  const threadId = values.get("thread");
  const expectedCodexHome = values.get("codex-home");
  if (threadId) options.threadId = threadId;
  if (expectedCodexHome) options.expectedCodexHome = expectedCodexHome;
  return options;
}
