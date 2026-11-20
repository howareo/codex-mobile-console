import { getSessionInfo, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeThreadCwd } from "../shared/cwd.js";
import type { ClaudeHistoryPage, ClaudeSessionList, ClaudeSessionSummary } from "../shared/claude.js";
import { ClaudeReadError, safeText, type ClaudeHistorySlice } from "./claude-history.js";
import { readClaudeHistoryPage } from "./claude-history-reader.js";
export { ClaudeReadError, projectClaudeMessage } from "./claude-history.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 30;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const CACHE_MS = 10_000;

export interface ClaudeReadApi {
  listSessions: typeof listSessions;
  readHistoryPage: typeof readClaudeHistoryPage;
  getSessionInfo?: typeof getSessionInfo;
}

const createdSchema = z.array(z.object({ sessionId: z.uuid(), cwd: z.string().min(1), lastModified: z.number().finite(), summary: z.string() }).strict()).max(1000);

export class ClaudeSessionStore {
  private cached: { sessions: SDKSessionInfo[]; expiresAt: number } | null = null;
  private listing: Promise<SDKSessionInfo[]> | null = null;
  private readonly reading = new Map<string, Promise<ClaudeHistorySlice>>();
  private readonly histories = new Map<string, { stamp: string; page: ClaudeHistorySlice; expiresAt: number }>();
  private readonly created: Promise<Map<string, SDKSessionInfo>>;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: ClaudeReadApi = { listSessions, getSessionInfo, readHistoryPage: readClaudeHistoryPage }, private readonly createdFile: string | null = null) {
    this.created = (async () => {
      if (!createdFile) return new Map<string, SDKSessionInfo>();
      try {
        const entries = createdSchema.parse(JSON.parse(await readFile(createdFile, "utf8")));
        return new Map(entries.map(entry => [entry.sessionId, { ...entry, fileSize: 0 }]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map<string, SDKSessionInfo>();
        throw new ClaudeReadError(503, "手机新建会话索引读取失败，已保留原文件，请检查服务日志");
      }
    })();
    void this.created.catch(() => undefined);
  }

  async create(id: string, cwd: string): Promise<ClaudeSessionSummary> {
    const normalized = normalizeThreadCwd(cwd);
    if (!UUID.test(id) || !normalized || !isAbsolute(normalized)) throw new ClaudeReadError(400, "请选择有效的绝对工作目录");
    const directory = await stat(normalized).catch(() => null);
    if (!directory?.isDirectory()) throw new ClaudeReadError(400, "工作目录不存在或不可访问，请选择已有文件夹");
    const operation = this.writing.then(async () => {
      const created = await this.created;
      const previous = created.get(id);
      if (previous) {
        if (previous.cwd !== normalized) throw new ClaudeReadError(409, "此创建编号已用于其他目录，请重新创建");
        return { ...summary(previous), pending: true };
      }
      if (created.size >= 1000) throw new ClaudeReadError(429, "手机新建会话已达上限，请先整理会话");
      if (await this.api.getSessionInfo?.(id)) throw new ClaudeReadError(409, "会话编号已存在，请重新创建");
      const session = { sessionId: id, cwd: normalized, lastModified: Date.now(), summary: "新 Claude 会话", fileSize: 0 };
      if (this.createdFile) {
        const temporary = `${this.createdFile}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.createdFile), { recursive: true });
        try {
          await writeFile(temporary, JSON.stringify([...created.values(), session].map(({ sessionId, cwd, lastModified, summary }) => ({ sessionId, cwd, lastModified, summary }))), { mode: 0o600 });
          await rename(temporary, this.createdFile);
        } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      }
      if (this.listing) await this.listing.catch(() => undefined);
      created.set(id, session);
      this.cached = null;
      return { ...summary(session), pending: true };
    });
    this.writing = operation.catch(() => undefined);
    return operation;
  }

  private async sessions(): Promise<SDKSessionInfo[]> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.sessions;
    if (this.listing) return this.listing;
    this.listing = this.api.listSessions({ limit: 1000, includeProgrammatic: false }).then(async sessions => {
      const created = await this.created;
      const mobile = await Promise.all([...created.values()].map(async session => await this.api.getSessionInfo?.(session.sessionId, { dir: session.cwd! }) || session));
      sessions = [...new Map([...mobile, ...sessions].map(session => [session.sessionId, session])).values()].sort((a, b) => b.lastModified - a.lastModified);
      const visible = sessions.filter(session => UUID.test(session.sessionId)).slice(0, 1000);
      this.cached = { sessions: visible, expiresAt: Date.now() + CACHE_MS };
      return visible;
    }).finally(() => { this.listing = null; });
    return this.listing;
  }

  async list(cursor?: string): Promise<ClaudeSessionList> {
    const offset = parseOffset(cursor, 1000);
    const sessions = await this.sessions();
    const created = await this.created;
    return {
      data: sessions.slice(offset, offset + PAGE_SIZE).map(session => ({ ...summary(session), ...(session.fileSize === 0 && created.has(session.sessionId) ? { pending: true } : {}) })),
      nextCursor: offset + PAGE_SIZE < sessions.length ? String(offset + PAGE_SIZE) : null,
      readOnly: true
    };
  }

  async read(id: string, cursor?: string): Promise<ClaudeHistoryPage> {
    if (!UUID.test(id)) throw new ClaudeReadError(400, "无效的 Claude 会话编号");
    if (cursor !== undefined && !UUID.test(cursor)) throw new ClaudeReadError(400, "无效的历史分页位置");
    const session = (await this.sessions()).find(item => item.sessionId === id);
    if (!session) throw new ClaudeReadError(404, "未找到 Claude 会话");
    if (!Number.isFinite(session.fileSize) || session.fileSize! < 0) throw new ClaudeReadError(503, "暂未取得 Claude 历史大小，请刷新列表后重试");
    if (session.fileSize! > MAX_FILE_BYTES) throw new ClaudeReadError(413, "会话文件超过当前 128 MiB 资源保护上限，原记录保持完整");
    if (session.fileSize === 0 && (await this.created).has(id)) return { session: { ...summary(session), pending: true }, messages: [], olderCursor: null, readOnly: true };
    return { session: summary(session), ...await this.loadPage(session, cursor), readOnly: true };
  }

  async find(id: string): Promise<ClaudeSessionSummary> {
    if (!UUID.test(id)) throw new ClaudeReadError(400, "无效的 Claude 会话编号");
    const session = (await this.sessions()).find(item => item.sessionId === id);
    if (!session) throw new ClaudeReadError(404, "未找到 Claude 会话，请刷新列表");
    return { ...summary(session), ...(session.fileSize === 0 && (await this.created).has(id) ? { pending: true } : {}) };
  }

  invalidate(id: string): void {
    this.cached = null;
    for (const key of this.histories.keys()) if (key.startsWith(`${id}:`)) this.histories.delete(key);
  }

  private async loadPage(session: SDKSessionInfo, cursor?: string): Promise<ClaudeHistorySlice> {
    const id = session.sessionId;
    const key = `${id}:${cursor || "latest"}`;
    const stamp = `${session.lastModified}:${session.fileSize}`;
    const cached = this.histories.get(key);
    if (cached?.stamp === stamp && cached.expiresAt > Date.now()) return cached.page;
    const existing = this.reading.get(key);
    if (existing) return existing;
    if (this.reading.size >= 1) throw new ClaudeReadError(429, "正在读取其他历史，请稍后再试");
    // Keep only projected pages; the isolated SDK reader owns and releases the full branch.
    const request = this.api.readHistoryPage(id, cursor).then(page => {
      if (this.histories.size >= 2) this.histories.delete(this.histories.keys().next().value!);
      this.histories.set(key, { stamp, page, expiresAt: Date.now() + CACHE_MS });
      return page;
    }).finally(() => { this.reading.delete(key); });
    this.reading.set(key, request);
    return request;
  }
}

function parseOffset(value: string | undefined, max: number): number {
  if (value === undefined) return 0;
  if (!/^\d{1,4}$/.test(value) || Number(value) > max) throw new ClaudeReadError(400, "无效的分页位置");
  return Number(value);
}

function summary(session: SDKSessionInfo): ClaudeSessionSummary {
  return { id: session.sessionId, title: safeText(session.customTitle || session.summary || "未命名会话", 160),
    cwd: session.cwd || null, updatedAt: session.lastModified, status: "unknown" };
}
