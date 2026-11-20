import { createHash } from "node:crypto";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { AppServerClient } from "../protocol/app-server-client.js";
import type { ToolDetailPage } from "../shared/types.js";

const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f/\\]+$/);
const paramsSchema = z.object({ threadId: id, turnId: id, itemId: id });
const querySchema = z.object({
  pageCursor: z.string().max(8192).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();
const CHUNK_CHARACTERS = 16_384;
type Detail = { kind: ToolDetailPage["kind"]; text: string; revision: string; expiresAt: number };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function toolDetailsUrl(threadId: string, turnId: string, itemId: string, pageCursor?: string): string {
  const path = `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/items/${encodeURIComponent(itemId)}/details`;
  return pageCursor ? `${path}?pageCursor=${encodeURIComponent(pageCursor)}` : path;
}

export function registerToolDetails(app: FastifyInstance, requireSession: preHandlerHookHandler,
  upstream: Pick<AppServerClient, "listThreadTurns">): void {
  // Only explicitly opened details are cached: at most eight 512K-character items.
  const cache = new Map<string, Detail>();
  app.addHook("onClose", async () => { cache.clear(); });
  app.get<{ Params: { threadId: string; turnId: string; itemId: string } }>(
    "/api/threads/:threadId/turns/:turnId/items/:itemId/details", { preHandler: requireSession }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const params = paramsSchema.safeParse(request.params);
      const query = querySchema.safeParse(request.query);
      if (!params.success || !query.success || query.data.offset > 0 && !query.data.revision) {
        return reply.code(400).send({ error: "详情参数有误，请刷新会话后重试" });
      }
      const { threadId, turnId, itemId } = params.data;
      const { offset, revision, pageCursor } = query.data;
      const key = JSON.stringify([threadId, turnId, itemId]);
      let detail = offset > 0 ? cache.get(key) : undefined;
      if (detail && (detail.expiresAt < Date.now() || detail.revision !== revision)) detail = undefined;
      if (!detail) {
        let cursor = pageCursor || null;
        let found: Record<string, unknown> | undefined;
        // The page hint handles old history; one extra page tolerates new turns at the head.
        for (let attempt = 0; attempt < 2; attempt++) {
          const page = await upstream.listThreadTurns(threadId, cursor, 10, "foreground");
          const turn = page.data.map(record).find(turn => String(turn.id) === turnId);
          if (turn) {
            found = (Array.isArray(turn.items) ? turn.items : []).map(record).find(item => String(item.id) === itemId);
            break;
          }
          if (!page.nextCursor || page.nextCursor === cursor) break;
          cursor = page.nextCursor;
        }
        if (!found || !["fileChange", "commandExecution"].includes(String(found.type))) {
          return reply.code(404).send({ error: "未找到这条工具记录，请刷新对应历史分页后重试" });
        }
        const kind = found.type === "fileChange" ? "diff" : "output";
        const output = found.aggregatedOutput ?? found.output ?? found.result;
        const text = kind === "diff"
          ? (Array.isArray(found.changes) ? found.changes : []).map(value => {
            const change = record(value);
            const diff = typeof change.diff === "string" ? change.diff : "（app-server 未提供此文件的差异）";
            return `文件：${typeof change.path === "string" ? change.path : "未知路径"}\n${diff}`;
          }).join("\n\n")
          : typeof output === "string" ? output : "";
        detail = { kind, text, revision: createHash("sha256").update(`${kind}\0${text}`).digest("hex"), expiresAt: Date.now() + 120_000 };
        cache.delete(key);
        if (text.length <= 512 * 1024) {
          if (cache.size >= 8) cache.delete(cache.keys().next().value!);
          cache.set(key, detail);
        }
      }
      if (offset > 0 && detail.revision !== revision) {
        return reply.code(409).send({ error: "详情内容已更新，请点击“刷新详情”重新读取，避免拼接不同版本" });
      }
      if (offset > detail.text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(detail.text[offset] || "") && /[\uD800-\uDBFF]/.test(detail.text[offset - 1] || "")) {
        return reply.code(400).send({ error: "详情分页位置无效，请重新读取" });
      }
      let end = Math.min(offset + CHUNK_CHARACTERS, detail.text.length);
      if (end < detail.text.length) {
        const newline = detail.text.lastIndexOf("\n", end - 1);
        if (newline >= offset + CHUNK_CHARACTERS / 2) end = newline + 1;
        else if (/[\uD800-\uDBFF]/.test(detail.text[end - 1] || "") && /[\uDC00-\uDFFF]/.test(detail.text[end] || "")) end--;
      }
      const result: ToolDetailPage = { kind: detail.kind, text: detail.text.slice(offset, end), offset,
        nextOffset: end < detail.text.length ? end : null, totalCharacters: detail.text.length, revision: detail.revision };
      return result;
    });
}
