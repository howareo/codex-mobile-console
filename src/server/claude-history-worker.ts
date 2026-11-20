import { parentPort, workerData } from "node:worker_threads";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeReadError, projectClaudePage } from "./claude-history.js";

try {
  const { id, cursor } = workerData as { id: string; cursor?: string };
  const messages = await getSessionMessages(id, { includeSystemMessages: false });
  parentPort!.postMessage({ page: projectClaudePage(messages, cursor) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof ClaudeReadError
    ? { statusCode: error.statusCode, message: error.message }
    : { statusCode: 503, message: "Claude 历史读取失败，请稍后重试；原记录保持完整" } });
}
