import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadMessages } from "../web/src/thread-messages";
import { ToolDetails, ToolDetailText } from "../web/src/tool-details";

const render = (items: unknown[], active = false) => renderToStaticMarkup(createElement(ThreadMessages, { items, active }));

describe("shared Codex and Claude conversation renderer", () => {
  it("offers full details without fetching on render and highlights escaped diffs", () => {
    const request = async <T,>(): Promise<T> => { throw new Error("Details must only load after a click"); };
    const html = renderToStaticMarkup(createElement(ToolDetails, { path: "/api/threads/t/turns/r/items/i/details", kind: "output", request }));
    expect(html).toContain("查看完整输出");
    expect(html).not.toContain("正在读取");
    const diff = renderToStaticMarkup(createElement(ToolDetailText, { kind: "diff", text: "@@ -1 +1 @@\n-old\n+<script>" }));
    expect(diff).toContain('class="diff-hunk"');
    expect(diff).toContain('class="diff-removed"');
    expect(diff).toContain('class="diff-added"');
    expect(diff).toContain("&lt;script&gt;");
    expect(diff).not.toContain("<script>");
  });
  it("groups consecutive live tools and renders the same conversation bubbles and Markdown", () => {
    const html = render([
      { id: "user", type: "userMessage", text: "开始" },
      { id: "read", type: "dynamicToolCall", tool: "Read", status: "completed", result: "已读取文件" },
      { id: "bash", type: "dynamicToolCall", tool: "Bash", status: "running", result: "npm test" },
      { id: "reply", type: "agentMessage", text: "**运行结果**\n\n|项目|状态|\n|---|---|\n|检查|通过|" }
    ], true);
    expect(html.match(/class="activity-group /g)).toHaveLength(1);
    expect(html).toContain("activity-group running open");
    expect(html).toContain("执行过程");
    expect(html).toContain("2 项");
    expect(html).toContain("npm test");
    expect(html).toContain("message-row user");
    expect(html).toContain("message-row agent");
    expect(html).toContain("<strong>运行结果</strong>");
    expect(html).toContain('class="message-table"');
  });

  it("renders signed report screenshots as a figure grid and turns local links into path chips", () => {
    const text = "已备齐\n\n![身份参考总览](/api/local-images?t=abc.sig)\n\n![十二表情总览](/api/local-images?t=def.sig)\n\n[查看原图](C:/work/refs) · ![外链](https://evil.example/x.png)";
    const html = render([{ type: "agentMessage", id: "m1", text }]);
    expect(html).toContain('class="message-figures "');
    expect(html).toContain('<img src="/api/local-images?t=abc.sig" alt="身份参考总览"');
    expect(html).toContain("<figcaption>十二表情总览</figcaption>");
    expect(html).toContain('class="path-chip folder ');
    expect(html).toContain(">查看原图<");
    expect(html).not.toContain('src="https://evil.example/x.png"');
  });

  it("renders headings, nested lists, quotes, code fences, file:line chips and drops citation markers", () => {
    const text = "## 修复结果\n\n1. 第一步\n2. 第二步\n   - 子项 `C:\\work\\app\\main.ts:42`\n\n> 引用说明\n\n```ts\nconst a = 1;\n```\n\n见 [main.ts](C:/work/app/main.ts#L10-L20) 与 C:\\work\\notes 。资料citeturn314478view0";
    const html = render([{ type: "agentMessage", id: "m2", text }]);
    expect(html).toContain('<h3 class="message-heading level-2">修复结果</h3>');
    expect(html).toContain('<ol start="1">');
    expect(html).toContain("<ul><li>子项 ");
    expect(html).toContain('class="message-quote"');
    expect(html).toContain('<span class="message-code-lang">ts</span><code>const a = 1;</code>');
    expect(html).toContain('<span class="path-chip-name">main.ts</span><span class="path-chip-line">:42</span>');
    expect(html).toContain('<span class="path-chip-line">:10-20</span>');
    expect(html).toContain('<span class="path-chip-name">notes</span>');
    expect(html).not.toContain("citeturn");
  });

  it("opens a streaming thinking block instead of hiding its incoming content", () => {
    const html = render([{ id: "thinking", type: "reasoning", summary: ["正在检查部署情况"] }], true);
    expect(html).toContain("activity-group running open");
    expect(html).toContain("tool-card running open");
    expect(html).toContain("正在检查部署情况");
  });

  it("collapses completed history and does not mark older groups as active", () => {
    const completed = { id: "read", type: "dynamicToolCall", tool: "Read", status: "completed", result: "完成" };
    expect(render([completed])).toContain("activity-group done collapsed");
    const html = render([completed, { id: "text", type: "agentMessage", text: "继续检查" }, { id: "last", type: "reasoning", summary: ["最新进度"] }], true);
    expect(html).toContain("activity-group done collapsed");
    expect(html).toContain("activity-group running open");
  });

  it.each([false, true])("keeps failed tools collapsed with a failure indicator (active: %s)", active => {
    const failed = render([{ id: "error", type: "dynamicToolCall", tool: "Bash", status: "failed", result: "502 Bad Gateway" }], active);
    expect(failed).toContain("activity-group failed collapsed");
    expect(failed).toContain('aria-expanded="false"');
    expect(failed).toContain('aria-controls="activity-error"');
    expect(failed).toContain("circle-alert");
    expect(failed).not.toContain("502 Bad Gateway");
    expect(failed).not.toContain('class="activity-items"');
  });
});
