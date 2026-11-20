import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentsFromDrop, createAttachmentDrafts, parseAttachmentMessage, uploadAttachment } from "../web/src/file-attachments";
import { formatMobileAttachments } from "../src/shared/attachments";

function file(name: string, relativePath = ""): File {
  const value = new File(["hello"], name);
  Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
  return value;
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex file attachments", () => {
  it("keeps ordinary files and archives separate, and preserves folder paths", () => {
    expect(createAttachmentDrafts([file("notes.txt"), file("project.zip")]).map(draft => [draft.kind, draft.name])).toEqual([["file", "notes.txt"], ["file", "project.zip"]]);
    const [folder] = createAttachmentDrafts([file("index.ts", "project/src/index.ts"), file("README.md", "project/README.md")], true);
    expect(folder).toMatchObject({ kind: "folder", name: "project", size: 10 });
    expect(folder!.files.map(entry => entry.path)).toEqual(["src/index.ts", "README.md"]);
    expect(() => createAttachmentDrafts([])).toThrow("没有可上传");
    expect(() => createAttachmentDrafts(Array.from({ length: 11 }, (_, i) => file(`${i}.txt`)))).toThrow("最多 10");
  });

  it("reads all batches from dragged folders", async () => {
    const entry = (name: string) => ({ name, isFile: true, isDirectory: false, file: (resolve: (value: File) => void) => resolve(file(name)) });
    const batches = [[entry("one.txt")], [entry("two.txt")], []];
    const root = { name: "folder", isFile: false, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift()!) }) };
    const data = { items: [{ webkitGetAsEntry: () => root }] } as unknown as DataTransfer;
    const [draft] = await attachmentsFromDrop(data);
    expect(draft!.files.map(value => value.path)).toEqual(["one.txt", "two.txt"]);
  });

  it("retains an uploaded attachment id for message retries", async () => {
    const draft = createAttachmentDrafts([file("project.zip")])[0]!;
    const result = { id: "uploaded-id", name: "project.zip", kind: "file", size: 5, fileCount: 1 };
    let uploads = 0;
    class Request {
      upload = {};
      status = 201;
      responseText = JSON.stringify({ attachment: result });
      onload?: () => void;
      open() {}
      send(data: FormData) {
        uploads++;
        expect(data.get("kind")).toBe("file");
        expect(data.get("file:project.zip")).toBeInstanceOf(File);
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", Request);
    expect(await uploadAttachment(draft, () => {})).toEqual(result);
    expect(await uploadAttachment(draft, () => {})).toEqual(result);
    expect(uploads).toBe(1);
  });

  it("renders attached names without showing local filesystem metadata", () => {
    const entry = { id: "upload", name: "报告.zip", kind: "file", path: "C:/private/upload/报告.zip" };
    expect(parseAttachmentMessage(`请查看\n${formatMobileAttachments([{ ...entry, kind: "file" }])}`)).toEqual({ text: "请查看", attachments: [{ id: "upload", name: "报告.zip", kind: "file" }] });
    const malformed = "<mobile-attachments>not-json</mobile-attachments>";
    expect(parseAttachmentMessage(malformed)).toEqual({ text: malformed, attachments: [] });
  });
});
