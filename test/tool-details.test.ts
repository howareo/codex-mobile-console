import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient } from "../src/protocol/app-server-client";
import type { ToolDetailPage } from "../src/shared/types";
import { registerToolDetails, toolDetailsUrl } from "../src/server/tool-details";

describe("on-demand tool details", () => {
  let app: ReturnType<typeof Fastify>;
  const calls: unknown[][] = [];
  let data: unknown[] = [];
  const path = toolDetailsUrl("thread-1", "turn-1", "tool-1");
  const start = () => {
    calls.length = 0;
    app = Fastify();
    const upstream = { listThreadTurns: async (...args: unknown[]) => {
      calls.push(args); return { data, nextCursor: null };
    } } as unknown as Pick<AppServerClient, "listThreadTurns">;
    registerToolDetails(app, async () => {}, upstream);
  };
  afterEach(async () => { await app?.close(); });

  it("returns complete Unicode output in bounded pages and reuses only explicitly requested details", async () => {
    const text = "a".repeat(16_383) + "😀" + "\n后续输出\n".repeat(5000);
    data = [{ id: "turn-1", items: [{ id: "tool-1", type: "commandExecution", aggregatedOutput: text }] }];
    start();
    expect(calls).toHaveLength(0);
    const first = await app.inject({ method: "GET", url: path });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    let page = first.json<ToolDetailPage>();
    let received = page.text;
    expect(page.text.length).toBe(16_383);
    while (page.nextOffset !== null) {
      const response = await app.inject({ method: "GET", url: `${path}?offset=${page.nextOffset}&revision=${page.revision}` });
      expect(response.statusCode).toBe(200);
      page = response.json<ToolDetailPage>();
      expect(page.text.length).toBeLessThanOrEqual(16_384);
      received += page.text;
    }
    expect(received).toBe(text);
    expect(calls).toEqual([["thread-1", null, 10, "foreground"]]);
  });

  it("keeps every file diff and uses the history page hint without resuming a task", async () => {
    data = [{ id: "turn-1", items: [{ id: "tool-1", type: "fileChange", changes: [
      { path: "src/one.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
      { path: "src/two.ts", diff: "+second file" }
    ] }] }];
    start();
    const response = await app.inject({ method: "GET", url: toolDetailsUrl("thread-1", "turn-1", "tool-1", "old+cursor=") });
    expect(response.json()).toMatchObject({ kind: "diff", nextOffset: null });
    expect(response.json().text).toContain("src/one.ts\n@@ -1 +1 @@\n-old\n+new");
    expect(response.json().text).toContain("src/two.ts\n+second file");
    expect(calls).toEqual([["thread-1", "old+cursor=", 10, "foreground"]]);
  });

  it("rejects invalid pagination and unrelated item IDs before returning any output", async () => {
    data = [{ id: "turn-1", items: [{ id: "tool-1", type: "commandExecution", output: "private task output" }] }];
    start();
    for (const query of ["offset=-1", "offset=2", "offset=1.5", "revision=invalid", "extra=value"]) {
      expect((await app.inject({ method: "GET", url: `${path}?${query}` })).statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const missing = await app.inject({ method: "GET", url: toolDetailsUrl("thread-1", "turn-1", "other-item") });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("private task output");
  });

  it("keeps pagination consistent, refreshes live output explicitly and rejects mixed versions", async () => {
    data = [{ id: "turn-1", items: [{ id: "tool-1", type: "commandExecution", output: "a".repeat(20_000) }] }];
    start();
    const first = (await app.inject({ method: "GET", url: path })).json<ToolDetailPage>();
    data = [{ id: "turn-1", items: [{ id: "tool-1", type: "commandExecution", output: "b".repeat(20_000) }] }];
    const next = await app.inject({ method: "GET", url: `${path}?offset=${first.nextOffset}&revision=${first.revision}` });
    expect(next.json().text).toBe("a".repeat(20_000 - first.text.length));
    const refreshed = (await app.inject({ method: "GET", url: path })).json<ToolDetailPage>();
    expect(refreshed.revision).not.toBe(first.revision);
    expect(refreshed.text).toBe("b".repeat(16_384));
    const stale = await app.inject({ method: "GET", url: `${path}?offset=${first.nextOffset}&revision=${first.revision}` });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("刷新详情");
  });
});
