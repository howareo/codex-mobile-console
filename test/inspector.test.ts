import { describe, expect, it } from "vitest";
import { approvalsForOtherTasks, changedFilesFromTurn, changeTotals, commandsFromTurn, countDiffLines, displayPath, linkRows, planForTurn, planRingPercent } from "../web/src/inspector";
import { filterThreads, searchThreads, threadFilterCounts, threadProject } from "../web/src/command-palette";
import type { PlanSnapshot } from "../web/src/plan-state";
import type { ApprovalRequest, ThreadSummary } from "../src/shared/types";

const turn = {
  id: "turn-3",
  status: "inProgress",
  items: [
    { type: "userMessage", id: "u1", content: [{ type: "text", text: "fix retry" }] },
    { type: "plan", id: "p1", text: "- [x] 找到重试入口\n- [ ] 跑支付测试\n- [ ] 汇报" },
    { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "C:\\work\\src\\main.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n context" }] },
    { type: "fileChange", id: "f2", status: "completed", changes: [
      { path: "C:\\work\\src\\pay\\deadletter.ts", kind: { type: "add" }, diff: "export const a = 1;\nexport const b = 2;\n" },
      { path: "c:/work/src/main.ts", kind: "update", diff: "@@ -9 +9 @@\n-x\n+y" }
    ] },
    { type: "fileChange", id: "f3", status: "declined", changes: [{ path: "C:\\work\\secret.txt", kind: { type: "add" }, diff: "nope" }] },
    { type: "commandExecution", id: "c1", status: "completed", command: "git status", exitCode: 0 },
    { type: "commandExecution", id: "c2", status: "failed", command: "npm test", exitCode: 1 },
    { type: "commandExecution", id: "c3", status: "inProgress", command: "npm run lint" }
  ]
};

describe("inspector changed files", () => {
  it("counts +/- lines without the file headers", () => {
    expect(countDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+newer")).toEqual({ added: 2, removed: 1 });
    expect(countDiffLines("+new\n-old")).toEqual({ added: 1, removed: 1 });
  });

  it("merges per path, counts added files by content lines and skips declined changes", () => {
    const files = changedFilesFromTurn(turn);
    expect(files.map(file => file.path)).toEqual(["C:\\work\\src\\main.ts", "C:\\work\\src\\pay\\deadletter.ts"]);
    expect(files[0]).toMatchObject({ kind: "update", added: 3, removed: 2 });
    expect(files[1]).toMatchObject({ kind: "add", added: 2, removed: 0 });
    expect(changeTotals(files)).toEqual({ files: 2, added: 5, removed: 2 });
  });

  it("prefers explicit added/removed counts and tolerates missing data", () => {
    const withCounts = { items: [{ type: "fileChange", changes: [{ path: "a.ts", kind: "update", added: 7, removed: 3, diff: "+x" }] }] };
    expect(changedFilesFromTurn(withCounts)[0]).toMatchObject({ added: 7, removed: 3 });
    expect(changedFilesFromTurn(null)).toEqual([]);
    expect(changedFilesFromTurn({ items: [{ type: "fileChange" }] })).toEqual([]);
  });

  it("shortens paths relative to the task cwd", () => {
    expect(displayPath("C:\\work\\src\\main.ts", "C:\\work")).toBe("src/main.ts");
    expect(displayPath("D:\\other\\a\\b\\c.ts", "C:\\work")).toBe("…/a/b/c.ts");
  });
});

describe("inspector plan", () => {
  const live: PlanSnapshot = { threadId: "t1", turnId: "turn-3", explanation: "改了方案", plan: [{ step: "A", status: "completed" }, { step: "B", status: "inProgress" }, { step: "C", status: "pending" }, { step: "D", status: "pending" }] };

  it("prefers the live snapshot, otherwise the plan item stored in the turn", () => {
    const fromSnapshot = planForTurn("t1", turn, { "t1:turn-3": live });
    expect(fromSnapshot).toMatchObject({ live: true, explanation: "改了方案" });
    expect(fromSnapshot?.steps).toHaveLength(4);
    const fromTurn = planForTurn("t1", turn, {});
    expect(fromTurn?.live).toBe(false);
    expect(fromTurn?.steps.map(step => step.status)).toEqual(["completed", "pending", "pending"]);
    expect(planForTurn("t1", { id: "turn-4", items: [] }, { "t1:turn-3": live })).toBeNull();
  });

  it("derives the ring percentage from completed steps", () => {
    expect(planRingPercent(live.plan)).toBe(25);
    expect(planRingPercent([])).toBe(0);
    expect(planRingPercent([{ step: "A", status: "completed" }, { step: "B", status: "completed" }])).toBe(100);
  });
});

describe("inspector command log and link rows", () => {
  it("lists commands newest first with exit codes and states", () => {
    const commands = commandsFromTurn(turn);
    expect(commands.map(command => [command.command, command.exitCode, command.state])).toEqual([
      ["npm run lint", null, "running"],
      ["npm test", 1, "failed"],
      ["git status", 0, "ok"]
    ]);
    expect(commandsFromTurn(turn, 1)).toHaveLength(1);
    expect(commandsFromTurn({ items: [{ type: "commandExecution", status: "interrupted", command: ["pnpm", "dev"] }] })[0]).toMatchObject({ command: "pnpm dev", state: "stopped" });
  });

  it("summarises the gateway status for the link panel", () => {
    const rows = linkRows({ upstream: { state: "open" }, maintenance: { active: false }, config: { state: "pending" }, claude: { sdkVersion: "0.3.316", expectedCliVersion: "2.1.0", cliVersion: "2.0.9", match: false } });
    expect(rows.map(row => [row.label, row.value, row.tone])).toEqual([
      ["4500 共享服务", "已连接", "ok"],
      ["维护窗口", "无", "muted"],
      ["待重载配置", "有", "warn"],
      ["Claude CLI", "版本不一致", "warn"]
    ]);
    expect(linkRows({ upstream: { state: "closed" }, maintenance: { active: true } })[0]?.tone).toBe("danger");
    expect(linkRows(null)[0]?.value).toBe("未知");
  });

  it("only returns approvals that belong to other known tasks", () => {
    const approvals: ApprovalRequest[] = [
      { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t1", command: "ls" } },
      { id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "t2", command: "git push" } },
      { id: "3", method: "execCommandApproval", params: { conversationId: "t3", command: ["rm", "x"] } },
      { id: 4, method: "item/permissions/requestApproval", params: {} }
    ];
    expect(approvalsForOtherTasks(approvals, "t1").map(approval => approval.id)).toEqual([2, "3"]);
    expect(approvalsForOtherTasks(approvals, null).map(approval => approval.id)).toEqual([1, 2, "3"]);
  });
});

describe("command palette helpers", () => {
  const threads: ThreadSummary[] = [
    { id: "t1", name: "支付回调重试修复", cwd: "C:\\fixtures\\Desktop\\shop-api", status: { type: "active" } },
    { id: "t2", title: "发布脚本加签名校验", cwd: "C:\\fixtures\\Desktop\\release-tools", status: "idle" },
    { id: "t3", name: "docs dark mode", cwd: "C:\\fixtures\\Desktop\\docs-site\\theme", status: "failed" },
    { id: "t4", cwd: null, status: "notLoaded" }
  ];
  const approvals: ApprovalRequest[] = [{ id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "t2", command: "git push" } }];

  it("filters by status class and pending approval", () => {
    expect(filterThreads(threads, "all", approvals)).toHaveLength(4);
    expect(filterThreads(threads, "running", approvals).map(thread => thread.id)).toEqual(["t1"]);
    expect(filterThreads(threads, "approval", approvals).map(thread => thread.id)).toEqual(["t2"]);
    expect(filterThreads(threads, "failed", approvals).map(thread => thread.id)).toEqual(["t3"]);
    expect(threadFilterCounts(threads, approvals)).toEqual({ all: 4, running: 1, approval: 1, failed: 1 });
  });

  it("matches name, project folder and cwd case-insensitively", () => {
    expect(threadProject("C:\\fixtures\\Desktop\\shop-api\\src")).toBe("shop-api");
    expect(searchThreads(threads, "SHOP").map(thread => thread.id)).toEqual(["t1"]);
    expect(searchThreads(threads, "dark mode").map(thread => thread.id)).toEqual(["t3"]);
    expect(searchThreads(threads, "theme").map(thread => thread.id)).toEqual(["t3"]);
    expect(searchThreads(threads, "签名").map(thread => thread.id)).toEqual(["t2"]);
    expect(searchThreads(threads, "  ")).toHaveLength(4);
    expect(searchThreads(threads, "nothing-like-this")).toEqual([]);
  });
});
