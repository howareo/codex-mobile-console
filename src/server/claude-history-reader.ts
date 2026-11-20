import { Worker } from "node:worker_threads";
import { ClaudeReadError, type ClaudeHistorySlice } from "./claude-history.js";

export function readClaudeHistoryPage(id: string, cursor?: string): Promise<ClaudeHistorySlice> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./claude-history-worker.js", import.meta.url), {
      workerData: { id, cursor }, resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let settled = false;
    const finish = (error?: ClaudeReadError, page?: ClaudeHistorySlice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => { if (error) reject(error); else resolve(page!); }, reject);
    };
    const timer = setTimeout(() => finish(new ClaudeReadError(503, "Claude 历史读取超时，请稍后重试；原记录保持完整")), 10_000);
    worker.once("message", (result: { page: ClaudeHistorySlice } | { error: { statusCode: number; message: string } }) => {
      if ("error" in result) finish(new ClaudeReadError(result.error.statusCode, result.error.message));
      else finish(undefined, result.page);
    });
    worker.once("error", () => finish(new ClaudeReadError(503, "Claude 历史解析超出读取资源预算或发生异常；原记录保持完整")));
    worker.once("exit", () => { if (!settled) finish(new ClaudeReadError(503, "Claude 历史读取提前结束，请重试")); });
  });
}
