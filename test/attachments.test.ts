import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/protocol/app-server-client.js";
import { createGatewayApp } from "../src/server/app.js";
import type { GatewayConfig } from "../src/server/config.js";
import { MOBILE_ATTACHMENTS_CLOSE, MOBILE_ATTACHMENTS_NOTE, MOBILE_ATTACHMENTS_OPEN, type AttachmentSummary } from "../src/shared/attachments.js";
import type { TurnInput } from "../src/shared/types.js";

vi.mock("../src/shared/attachments.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/shared/attachments.js")>(),
  MAX_ATTACHMENT_FILE_BYTES: 16,
  MAX_ATTACHMENT_TOTAL_BYTES: 25,
  MAX_ATTACHMENT_FILES: 3
}));

class TestUpstream extends EventEmitter {
  readonly inputs: (string | TurnInput[])[] = [];
  async readThreadMetadata(id: string) { return { thread: { id } }; }
  async resumeThread(id: string) { return { thread: { id } }; }
  async unsubscribeThread() { return { status: "unsubscribed" }; }
  async startTurn(_id: string, input: string | TurnInput[]) {
    this.inputs.push(input);
    return { turn: { id: "new-turn" } };
  }
}

const tempRoot = resolve(tmpdir());
const secret = "test-token-for-attachment-api-123456";
let dir: string;
let uploadRoot: string;
let config: GatewayConfig;
let upstream: TestUpstream;
let app: Awaited<ReturnType<typeof createGatewayApp>>;
let cookie: string;

async function openGateway() {
  upstream = new TestUpstream();
  app = await createGatewayApp(config, upstream as unknown as AppServerClient);
  const login = await app.inject({ method: "POST", url: "/api/auth/session", payload: { token: secret } });
  expect(login.statusCode).toBe(200);
  cookie = login.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tempRoot, "codex-attachment-test-"));
  uploadRoot = join(dir, "uploads");
  config = {
    appServerUrl: "ws://127.0.0.1:4500", pairingSecret: secret,
    host: "127.0.0.1", port: 4174, staticRoot: join(dir, "none"),
    logFile: null, sessionStoreFile: null, sessionTtlMs: 60_000, uploadRoot,
    imageUploadRoot: join(dir, "images")
  };
  await openGateway();
});

afterEach(async () => {
  await app?.close();
  if (dir && dirname(dir) === tempRoot) await rm(dir, { recursive: true, force: true });
});

type UploadFile = [string, string | Uint8Array<ArrayBuffer>];
async function upload(kind: string, name: string, files: UploadFile[], headers: Record<string, string> = { cookie }) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("name", name);
  for (const [path, contents] of files) form.append(`file:${path}`, new Blob([contents]), path.split("/").at(-1)!);
  const request = new Request("http://localhost", { method: "POST", body: form });
  return app.inject({
    method: "POST", url: "/api/attachments", headers: { "content-type": request.headers.get("content-type")!, ...headers },
    payload: Buffer.from(await request.arrayBuffer())
  });
}

async function uploaded(kind: string, name: string, files: UploadFile[]): Promise<AttachmentSummary> {
  const result = await upload(kind, name, files);
  expect(result.statusCode, result.body).toBe(201);
  return result.json<{ attachment: AttachmentSummary }>().attachment;
}

function send(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/threads/t1/turns", headers: { cookie }, payload });
}

function manifest(text: string): Array<{ id: string; name: string; kind: string; path: string }> {
  const [prefix, json] = text.split(MOBILE_ATTACHMENTS_OPEN, 2);
  expect(prefix).toBe("");
  const [manifestJson, note] = json!.split(MOBILE_ATTACHMENTS_CLOSE);
  expect(note?.trim()).toBe(MOBILE_ATTACHMENTS_NOTE);
  return JSON.parse(manifestJson!);
}

describe("mobile attachments", () => {
  it("preserves directory structure and archive bytes, and sends persistent references alongside text and images", async () => {
    const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x00, 0xff);
    const archive = await uploaded("file", "源.zip", [["源.zip", bytes]]);
    const folder = await uploaded("folder", "目录", [["子目录/a.txt", "abc"], ["子目录/b.txt", "xy"], ["top.txt", ""]]);
    expect(archive).toEqual({ id: expect.any(String), name: "源.zip", kind: "file", size: bytes.length, fileCount: 1 });
    expect(folder).toEqual({ id: expect.any(String), name: "目录", kind: "folder", size: 5, fileCount: 3 });
    await app.close();
    await openGateway();

    expect((await send({ attachments: [folder.id] })).statusCode).toBe(200);
    const attachmentInput = (upstream.inputs[0] as TurnInput[])[0];
    expect(attachmentInput?.type).toBe("text");
    const [folderRef] = manifest(attachmentInput?.type === "text" ? attachmentInput.text : "");
    expect(folderRef).toEqual({ id: folder.id, name: folder.name, kind: "folder", path: join(await realpath(uploadRoot), folder.id, "content", "目录") });
    expect(await readFile(join(folderRef!.path, "子目录", "a.txt"), "utf8")).toBe("abc");
    expect(await readFile(join(folderRef!.path, "top.txt"), "utf8")).toBe("");

    const imageId = `${randomUUID()}.png`;
    const imagePath = join(config.imageUploadRoot!, imageId);
    await mkdir(config.imageUploadRoot!);
    await writeFile(imagePath, "existing image fixture");
    expect((await send({ text: "read this", images: [imageId], attachments: [archive.id, folder.id, archive.id.toUpperCase()] })).statusCode).toBe(200);
    const input = upstream.inputs[1] as TurnInput[];
    expect(input[0]).toEqual({ type: "text", text: "read this" });
    const text = input[1];
    expect(text?.type).toBe("text");
    const refs = manifest(text?.type === "text" ? text.text : "");
    expect(refs.map(ref => ref.id)).toEqual([archive.id, folder.id]);
    expect(refs[0]?.name).toBe("源.zip");
    expect(await readFile(refs[0]!.path)).toEqual(Buffer.from(bytes));
    expect(input[2]).toEqual({ type: "localImage", path: imagePath, detail: "auto" });
  });

  it("rejects unauthenticated and cross-origin uploads before writing", async () => {
    expect((await upload("file", "a", [["a", "x"]], {})).statusCode).toBe(401);
    expect((await upload("file", "a", [["a", "x"]], { cookie, origin: "https://untrusted.example" })).statusCode).toBe(403);
    await expect(readdir(uploadRoot)).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each(["../outside", "a/../b", "/outside", "a\\b", "C:/outside", "file:stream", "nested/CON.txt", "nested/LPT¹.txt", "a/ending."])(
    "rejects invalid Windows attachment path %s",
    async path => {
      const result = await upload("folder", "docs", [["good", "ok"], [path, "bad"]]);
      expect(result.statusCode, result.body).toBe(400);
      expect(await readdir(uploadRoot)).toEqual([]);
    }
  );

  it.each([
    ["letter case on files", "a/Shared.txt", "a/shared.txt"],
    ["letter case on directories", "a/a.txt", "A/b.txt"],
    ["file and directory conflict", "a", "a/b"]
  ])("rejects duplicate attachment paths involving %s", async (_label, first, second) => {
    const result = await upload("folder", "docs", [[first, "one"], [second, "two"]]);
    expect(result.statusCode, result.body).toBe(400);
    expect(await readdir(uploadRoot)).toEqual([]);
  });

  it.each<[string, UploadFile[]]>([
    ["one large file", [["a", "x".repeat(17)]]],
    ["large total", [["a", "x".repeat(14)], ["b", "x".repeat(12)]]],
    ["too many files", [["a", ""], ["b", ""], ["c", ""], ["d", ""]]]
  ])("rejects %s and cleans up the partial upload", async (_label, files) => {
    const result = await upload("folder", "docs", files);
    expect(result.statusCode, result.body).toBe(413);
    expect(await readdir(uploadRoot)).toEqual([]);
  });

  it("accepts only registered ids on sends and caps their count", async () => {
    const id = randomUUID();
    const incomplete = join(uploadRoot, id, "content");
    await mkdir(incomplete, { recursive: true });
    await writeFile(join(incomplete, "waiting.txt"), "incomplete");
    for (const attachments of [[join(dir, "outside.txt")], [id], Array(11).fill(id)]) {
      expect((await send({ attachments })).statusCode).toBe(400);
    }
    expect(upstream.inputs).toEqual([]);
  });
});
