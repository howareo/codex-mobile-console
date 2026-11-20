import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeThreadPage } from "../web/src/thread-history";
import { itemDetails, itemImages, itemRole, itemSummary, itemType, statusClass, statusText, toolLabel } from "../web/src/thread-items";
import { formatConversationTime, formatDurationMs, turnDurationMs } from "../web/src/time-format";
import { createErrorText, interruptErrorText, sendErrorText, turnErrorText } from "../web/src/error-text";
import { normalizeThreadCwd, uniqueThreadCwds } from "../src/shared/cwd";
import { latestPlanFromTurn, parsePlanText, planNotification, planProgress, planSnapshotKey } from "../web/src/plan-state";
import { parseMarkdownTable } from "../web/src/message-markdown";
import { THEME_OPTIONS, THEME_STORAGE_KEY, parseThemeMode, readThemeMode, writeThemeMode } from "../web/src/theme";
import { cacheNamespace, clearClientCaches, clearThreadOverride, mergeThreadMetadata, mergeThreadSummary, pickThreadFields, pollIntervalMs, readClientCache, realtimeThreadId, resumeDecision, shouldReportAuthExpired, writeClientCache, type StorageLike } from "../web/src/pwa-state";

function channel(hex: string): number[] {
  return [1, 3, 5].map(index => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = channel(hex);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

describe("移动端消息呈现", () => {
  it("解析 GFM 表格并保留列对齐与转义竖线", () => {
    const table = parseMarkdownTable([
      "| 名称 | 数量 | 说明 |",
      "| :--- | ---: | :---: |",
      "| **主机** | 2 | Windows \\| EasyTier |",
      "| 手机 | 1 | `Safari` |"
    ]);
    expect(table).toEqual({
      headers: ["名称", "数量", "说明"],
      rows: [["**主机**", "2", "Windows \\| EasyTier"], ["手机", "1", "`Safari`"]],
      align: ["left", "right", "center"]
    });
    expect(parseMarkdownTable(["普通文本", "---"])).toBeNull();
  });

  it("表格滚动限制在消息内，避免手机整页缩放", () => {
    const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(css).toContain("text-size-adjust: 100%");
    expect(css).toContain(".turn-messages { overflow-x: clip; }");
    expect(css).not.toContain(".content, .turn-messages { overflow-x: clip; }");
    expect(css).toContain("input, select, textarea { font-size: 16px; }");
    expect(css).toContain(".message-markdown:has(.message-table) { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; }");
    expect(css).toContain(".message-table-wrap { min-width: 0; width: 100%; max-width: 100%;");
    expect(css).toContain("table-layout: fixed");
  });

  it("Claude 固定输入框只在手机尺寸预留底部空间", () => {
    const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width: 860px\) \{\s*\.claude-layout\.has-selection \{ padding-bottom: 190px; \}\s*\}/);
  });

  it("将文件、命令和思考事件转换为中文折叠摘要", () => {
    const fileChange = { type: "fileChange", id: "file-1", status: "completed", changes: [{ path: "C:\\work\\src\\main.ts", kind: { type: "update" }, diff: "+new\n-old" }] };
    const command = { type: "commandExecution", id: "command-1", status: "failed", command: "npm test", exitCode: 1 };
    const reasoning = { type: "reasoning", id: "reason-1", summary: ["检查协议"] };
    expect(toolLabel(fileChange)).toBe("修改文件");
    expect(toolLabel(command)).toBe("执行命令");
    expect(toolLabel(reasoning)).toBe("思考");
    expect(itemSummary(fileChange)).toContain("main.ts");
    expect(itemDetails(fileChange)[0]).toContain("更新");
    expect(itemDetails(command)).toContain("退出码：1");
    expect(itemSummary(reasoning)).toBe("1 段思考");
    expect([toolLabel(fileChange), toolLabel(command), toolLabel(reasoning)]).not.toContain("fileChange");
  });

  it("保留消息角色并映射新旧任务状态", () => {
    expect(itemRole({ type: "userMessage" })).toBe("user");
    expect(itemRole({ type: "agentMessage" })).toBe("agent");
    expect(statusClass("active")).toBe("running");
    expect(statusClass({ status: "running" })).toBe("running");
    expect(statusText({ status: "running" })).toBe("运行中");
    expect(statusClass("systemError")).toBe("failed");
    expect(statusText("interrupted")).toBe("已停止");
    expect(turnErrorText({ status: "systemError", error: { message: "unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses", additionalDetails: "upstream overloaded" } })).toContain("当前服务拥挤，请重试");
    expect(turnErrorText({ status: "systemError", error: { message: "unexpected status 502", additionalDetails: "token=private-secret" } })).not.toContain("private-secret");
  });

  it("只把网关上传的图片映射为认证图片地址", () => {
    const imageId = "123e4567-e89b-42d3-a456-426614174000.png";
    expect(itemImages({ type: "userMessage", content: [{ type: "text", text: "看图" }, { type: "localImage", path: `C:\\private\\${imageId}` }] })).toEqual([
      { imageId, src: `/api/images/${imageId}` }
    ]);
    expect(itemImages({ type: "userMessage", content: [{ type: "localImage", path: "C:\\fixtures\\photo.png" }] })).toEqual([]);
  });

  it("把 Codex 回图显示为带认证地址的对话图片", () => {
    expect(itemType({ type: "ImageView" })).toBe("imageView");
    expect(itemRole({ type: "imageView", id: "view-1", src: "/api/local-images?t=token.sig" })).toBe("agent");
    expect(itemImages({ type: "imageView", id: "view-1", src: "/api/local-images?t=token.sig", path: "cat-mascots.png" })).toEqual([
      { imageId: "view-1", src: "/api/local-images?t=token.sig" }
    ]);
    expect(itemImages({ type: "imageGeneration", id: "gen-1", src: "/api/local-images?t=token.sig", savedPath: "out.png" })).toEqual([
      { imageId: "gen-1", src: "/api/local-images?t=token.sig" }
    ]);
    expect(itemImages({ type: "imageView", src: "https://evil.example/x.png" })).toEqual([]);
    expect(itemRole({ type: "imageView", path: "C:\\secret\\photo.png" })).toBe("tool");
  });

  it("保持日夜两套主题和高对比档的边界对比度", () => {
    const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
    const block = (selector: string): Record<string, string> => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = css.slice(start, css.indexOf("}", start));
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
    };
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    const lightContrast = block(".app-shell.high-contrast");
    const darkContrast = block(':root[data-theme="dark"] .app-shell.high-contrast');
    // The auto-dark media block must carry the same values as the forced dark theme.
    const autoDark = css.slice(css.indexOf(':root:not([data-theme="light"]) {'), css.indexOf(':root[data-theme="dark"] {'));
    for (const [name, value] of Object.entries(dark)) expect(autoDark, name).toContain(`${name}: ${value};`);
    // Borders of controls: 3:1. Text and status colours: 4.5:1 on the canvas.
    for (const tokens of [light, dark]) {
      expect(contrast(tokens["--border-strong"]!, tokens["--canvas"]!)).toBeGreaterThanOrEqual(3);
      for (const name of ["--text-muted", "--text-secondary", "--accent-text", "--run", "--warn", "--danger", "--danger-ink"]) {
        expect(contrast(tokens[name]!, tokens["--canvas"]!), name).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens[name]!, tokens["--surface-1"]!), name).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(darkContrast["--border-strong"]!, darkContrast["--canvas"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkContrast["--text-muted"]!, darkContrast["--canvas"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightContrast["--border-strong"]!, lightContrast["--canvas"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightContrast["--text-muted"]!, lightContrast["--surface-3"]!)).toBeGreaterThanOrEqual(4.5);
    // Spot-check the real dark tokens (previously hard-coded here against the old canvas).
    expect(dark["--canvas"]).toBe("#06080c");
    expect(dark["--border-strong"]).toBe("#5a6579");
    expect(dark["--text-muted"]).toBe("#8b94a7");
    expect(darkContrast["--border-strong"]).toBe("#7a869b");
    expect(darkContrast["--canvas"]).toBe("#07080b");
  });

  it("主题偏好保存在 localStorage，存储不可用时回退到跟随系统", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    expect(readThemeMode(storage)).toBe("auto");
    writeThemeMode("dark", storage);
    expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemeMode(storage)).toBe("dark");
    expect(parseThemeMode("sepia")).toBe("auto");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readThemeMode(broken)).toBe("auto");
    expect(() => writeThemeMode("light", broken)).not.toThrow();
    expect(THEME_OPTIONS.map(option => option.label)).toEqual(["跟随系统", "日间", "夜间"]);
  });

  it("合并更早记录并保留实时更新的最近记录", () => {
    const latest = { thread: { id: "thread-1", turns: [{ id: "turn-10", status: "inProgress" }, { id: "turn-11" }] }, history: { kind: "head" as const, olderCursor: "cursor-10", hasOlder: true } };
    const older = { thread: { id: "thread-1", turns: [{ id: "turn-8" }, { id: "turn-9" }] }, history: { kind: "older" as const, olderCursor: "cursor-8", hasOlder: true } };
    const expanded = mergeThreadPage(latest, older);
    const refreshed = mergeThreadPage(expanded, { ...latest, thread: { ...latest.thread, turns: [{ id: "turn-10", status: "completed" }, { id: "turn-11" }] } });
    expect(refreshed.history).toEqual({ kind: "head", olderCursor: "cursor-8", hasOlder: true, loadedOlder: true });
    expect(refreshed.thread.turns).toEqual([{ id: "turn-8" }, { id: "turn-9" }, { id: "turn-10", status: "completed" }, { id: "turn-11" }]);
  });

  it("格式化对话时间、处理耗时和运行中轮次", () => {
    const now = new Date(2026, 7, 10, 20, 30, 0, 0).getTime();
    expect(formatConversationTime(now - 2 * 60 * 1000, now)).toBe("20:28");
    expect(formatConversationTime(new Date(2026, 7, 9, 23, 45, 0, 0).getTime(), now)).toBe("8月9日 23:45");
    expect(formatDurationMs(189_291)).toBe("3分09秒");
    const startedAt = Math.floor(now / 1000) - 4;
    expect(turnDurationMs({ startedAt, durationMs: 189_291 }, now)).toBe(189_291);
    expect(turnDurationMs({ startedAt, status: "inProgress" }, now)).toBe(4_000);
  });

  it("只让当前认证世代的 401 触发退出", () => {
    expect(shouldReportAuthExpired(3, 3, 401, "/api/threads")).toBe(true);
    expect(shouldReportAuthExpired(2, 3, 401, "/api/threads")).toBe(false);
    expect(shouldReportAuthExpired(3, 3, 401, "/api/auth/session")).toBe(false);
    expect(shouldReportAuthExpired(3, 3, 500, "/api/threads")).toBe(false);
  });

  it("在发送或停止失败时保留上游状态、中文原因和 URL", () => {
    const cause = new Error("502: unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses");
    expect(sendErrorText(cause)).toContain("unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses");
    expect(interruptErrorText(cause)).toContain("unexpected status 502 Bad Gateway: 当前服务拥挤，请重试。, url: http://localhost:3001/v1/responses");
    expect(sendErrorText(new Error("status: 502 token=private-secret"))).toContain("token=[已隐藏]");
    expect(sendErrorText(new Error("status: 502 token=private-secret"))).not.toContain("private-secret");
  });

  it("规范化 Windows verbatim 路径并去重工作区", () => {
    const verbatim = "\\\\?\\C:\\projects\\codex";
    expect(normalizeThreadCwd(verbatim)).toBe("C:\\projects\\codex");
    expect(normalizeThreadCwd("relative-folder")).toBeNull();
    expect(uniqueThreadCwds([
      { cwd: "C:\\projects\\codex" },
      { cwd: verbatim },
      { cwd: "C:\\projects\\shop-app" }
    ])).toEqual([
      "C:\\projects\\codex",
      "C:\\projects\\shop-app"
    ]);
    expect(createErrorText(new Error("cwd must be an absolute workspace path"))).toContain("绝对路径");
  });

  it("解析实时计划通知并计算当前步骤", () => {
    const snapshot = planNotification({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", explanation: "按顺序处理", plan: [{ step: "确认边界", status: "completed" }, { step: "实现数据层", status: "inProgress" }, { step: "设计模型", status: "pending" }, { step: "接入界面", status: "pending" }, { step: "执行验证", status: "pending" }, { step: "整理交付", status: "pending" }] } });
    expect(snapshot).toMatchObject({ threadId: "thread-1", turnId: "turn-1", explanation: "按顺序处理" });
    expect(planProgress(snapshot?.plan || [])).toEqual({ completed: 1, currentStep: 2, total: 6 });
    expect(planSnapshotKey("thread-1", "turn-1")).toBe("thread-1:turn-1");
  });

  it("将历史 Markdown 清单降级为结构化计划", () => {
    expect(parsePlanText("说明\n- [x] 已完成\n- [ ] 待处理")).toEqual([{ step: "已完成", status: "completed" }, { step: "待处理", status: "pending" }]);
    expect(latestPlanFromTurn({ items: [{ type: "plan", text: "- [x] 第一项\n- [ ] 第二项" }] })).toEqual([{ step: "第一项", status: "completed" }, { step: "第二项", status: "pending" }]);
    expect(planProgress([{ step: "第一项", status: "completed" }, { step: "第二项", status: "pending" }])).toEqual({ completed: 1, currentStep: 2, total: 2 });
  });

  it("在没有实时状态时定位首个待办，并在全部完成时停在末步", () => {
    expect(planProgress([{ step: "第一项", status: "pending" }, { step: "第二项", status: "pending" }])).toEqual({ completed: 0, currentStep: 1, total: 2 });
    expect(planProgress([{ step: "第一项", status: "completed" }, { step: "第二项", status: "completed" }])).toEqual({ completed: 2, currentStep: 2, total: 2 });
    expect(planProgress([])).toEqual({ completed: 0, currentStep: 0, total: 0 });
  });

  it("拒绝异常计划数据以保留原始计划工具卡", () => {
    expect(planNotification({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "未知", status: "waiting" }] } })).toBeNull();
    expect(planNotification({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [] } })).toBeNull();
    expect(parsePlanText("计划正在生成，请稍候")).toBeNull();
    expect(latestPlanFromTurn({ items: [{ type: "plan", text: "计划正在生成，请稍候" }] })).toBeNull();
  });

  it("缓存只保留任务元数据并按认证世代隔离", () => {
    const storage = memoryStorage();
    const origin = "https://mobile.example.test:4174";
    const session = { ok: true as const, epoch: "epoch-a", expiresAt: Date.now() + 60_000 };
    expect(cacheNamespace(origin, "build-a", "epoch-a")).not.toBe(cacheNamespace(origin, "build-b", "epoch-a"));
    expect(cacheNamespace(origin, "build-a", "epoch-a")).not.toBe(cacheNamespace(origin, "build-a", "epoch-b"));
    expect(pickThreadFields({ id: "thread-1", title: "标题", cwd: "C:\\work", source: { private: true }, extra: "drop" })).toEqual({ id: "thread-1", title: "标题", cwd: "C:\\work" });

    writeClientCache(storage, origin, "build-a", session, [{ id: "thread-1", title: "标题", source: "drop" }], { "thread-1": "草稿" }, "thread-1");
    const key = cacheNamespace(origin, "build-a", "epoch-a");
    expect(readClientCache(storage, origin, "build-a", "epoch-a")).toMatchObject({ threads: [{ id: "thread-1", title: "标题" }], drafts: { "thread-1": "草稿" }, modelOverrides: {}, reasoningOverrides: {} });
    const oldCache = JSON.parse(storage.getItem(key)!);
    oldCache.modelOverrides = { "thread-1": "old-model" };
    oldCache.reasoningOverrides = { "thread-1": "ultra" };
    storage.setItem(key, JSON.stringify(oldCache));
    expect(readClientCache(storage, origin, "build-a", "epoch-a")).toMatchObject({ drafts: { "thread-1": "草稿" }, modelOverrides: {}, reasoningOverrides: {} });
    expect(readClientCache(storage, origin, "build-a", "epoch-b")).toBeNull();
    clearClientCaches(storage);
    expect(storage.length).toBe(0);
  });

  it("选择跟随任务时删除移动端临时覆盖", () => {
    expect(clearThreadOverride({ "thread-1": "gpt-5.6-sol", "thread-2": "gpt-5.6-terra" }, "thread-1")).toEqual({ "thread-2": "gpt-5.6-terra" });
    expect(clearThreadOverride({ "thread-1": "high" }, "thread-1")).toEqual({});
  });

  it("在隐藏和假活连接之间选择正确恢复策略", () => {
    expect(resumeDecision({ lastFrameAgeMs: 1_000, readyState: WebSocket.OPEN, visibility: "hidden" })).toBe("idle");
    expect(resumeDecision({ lastFrameAgeMs: 31_000, readyState: WebSocket.OPEN, visibility: "visible" })).toBe("reconnect");
    expect(resumeDecision({ lastFrameAgeMs: 1_000, readyState: WebSocket.OPEN, visibility: "visible" })).toBe("resync");
    expect(resumeDecision({ lastFrameAgeMs: 1_000, readyState: WebSocket.CLOSED, visibility: "visible" })).toBe("reconnect");
    expect(pollIntervalMs({ visibility: "hidden", realtimeState: "polling" })).toBeNull();
    expect(pollIntervalMs({ visibility: "visible", realtimeState: "open" })).toBeNull();
    expect(pollIntervalMs({ visibility: "visible", realtimeState: "polling" })).toBe(10_000);
  });

  it("只在聊天详情可见时保留实时任务订阅", () => {
    expect(realtimeThreadId("threads", "thread-1")).toBe("thread-1");
    expect(realtimeThreadId("threads", null)).toBeNull();
    expect(realtimeThreadId("live", "thread-1")).toBeNull();
    expect(realtimeThreadId("settings", "thread-1")).toBeNull();
  });

  it("用按需读取的真实会话参数覆盖列表摘要", () => {
    const detail = { id: "thread-1", model: "stale-detail-model", turns: [{ id: "turn-1" }] };
    const listed = mergeThreadSummary(detail, {
      id: "thread-1",
      model: "gpt-session",
      modelProvider: "openai",
      reasoningEffort: "xhigh"
    });
    const merged = mergeThreadMetadata(listed, {
      id: "thread-1",
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      reasoningEffort: "high"
    });
    expect(merged).toEqual({
      id: "thread-1",
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      reasoningEffort: "high",
      turns: [{ id: "turn-1" }]
    });
    expect(mergeThreadSummary(detail, { id: "thread-other", model: "wrong" })).toBe(detail);
  });
});

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    key: index => [...values.keys()][index] ?? null
  };
}
