import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS_PER_TURN,
  type AttachmentKind, type AttachmentReference, type AttachmentSummary
} from "../shared/attachments.js";
import type { GatewayLogger } from "./diagnostics.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const INVALID_NAME = /[\u0000-\u001f<>:"/\\|?*]|[. ]$/u;
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/i;
const MAX_RELATIVE_PATH = 2048;
const MANIFEST = "manifest.json";

class UploadError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export async function registerAttachments(
  app: FastifyInstance,
  root: string | null | undefined,
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  logger: GatewayLogger
): Promise<void> {
  await app.register(async scope => {
    await scope.register(multipart, { throwFileSizeLimit: false });
    scope.post("/api/attachments", { onRequest: requireSession }, async (request, reply) => {
      if (!root) return reply.code(503).send({ error: "attachment uploads are not configured" });
      try {
        const attachment = await storeAttachment(root, request);
        logger.info("attachment.uploaded", { requestId: request.id, attachmentId: attachment.id, kind: attachment.kind, size: attachment.size, fileCount: attachment.fileCount });
        return reply.code(201).send({ attachment });
      } catch (error) {
        if (error instanceof UploadError) return reply.code(error.statusCode).send({ error: error.message });
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") return reply.code(413).send({ error: "too many attachment files" });
          if (code?.startsWith("FST_") || /^(?:Multipart: |Unexpected end of multipart data|Part terminated early)/.test(error.message)) {
            return reply.code(400).send({ error: "invalid attachment multipart body" });
          }
          logger.error("attachment.upload_failed", { requestId: request.id, code });
        }
        return reply.code(500).send({ error: "attachment storage failed" });
      }
    });
  });
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !INVALID_NAME.test(name) && !DEVICE_NAME.test(name.split(".", 1)[0]!.trimEnd());
}

function validKind(kind: unknown): kind is AttachmentKind {
  return kind === "file" || kind === "folder";
}

async function storeAttachment(root: string, request: FastifyRequest): Promise<AttachmentSummary> {
  const id = randomUUID();
  let location: string | undefined;
  let absoluteRoot: string | undefined;
  let name: string | undefined;
  let kind: AttachmentKind | undefined;
  let size = 0;
  let fileCount = 0;
  let committed = false;
  const paths = new Map<string, string | null>();
  try {
    for await (const part of request.parts({
      limits: { fields: 2, fieldSize: 1024, files: MAX_ATTACHMENT_FILES, fileSize: MAX_ATTACHMENT_FILE_BYTES, parts: MAX_ATTACHMENT_FILES + 2 }
    })) {
      if (part.type === "field") {
        if (part.valueTruncated || part.fieldnameTruncated || fileCount > 0) throw new UploadError("invalid attachment metadata");
        if (part.fieldname === "kind" && kind === undefined && validKind(part.value)) kind = part.value;
        else if (part.fieldname === "name" && name === undefined && validName(part.value)) name = part.value;
        else throw new UploadError("invalid attachment metadata");
        continue;
      }
      part.file.once("limit", () => part.file.destroy(new UploadError("attachment file exceeds the size limit", 413)));
      try {
        if (!kind || !name) throw new UploadError("attachment kind and name must precede files");
        if (kind === "file" && fileCount > 0) throw new UploadError("a file attachment must contain one file");
        const relativePath = part.fieldname.startsWith("file:") ? part.fieldname.slice(5) : "";
        const segments = relativePath.split("/");
        if (relativePath.length > MAX_RELATIVE_PATH || !segments.every(validName) || (kind === "file" && relativePath !== name)) {
          throw new UploadError("invalid attachment path");
        }
        if (!location) {
          await mkdir(root, { recursive: true, mode: 0o700 });
          absoluteRoot = await realpath(root);
          const target = join(absoluteRoot, id);
          await mkdir(target, { mode: 0o700 });
          location = target;
          await mkdir(join(location, "content"), { mode: 0o700 });
          if (kind === "folder") await mkdir(join(location, "content", name), { mode: 0o700 });
        }
        const base = kind === "folder" ? join(location, "content", name) : join(location, "content");
        const filename = segments.pop()!;
        let parent = base;
        for (const segment of segments) {
          parent = join(parent, segment);
          const key = parent.toUpperCase();
          const existing = paths.get(key);
          if (existing !== undefined && existing !== parent) throw new UploadError("duplicate attachment path");
          if (existing === undefined) {
            await mkdir(parent, { mode: 0o700 });
            paths.set(key, parent);
          }
        }
        const destination = join(parent, filename);
        const key = destination.toUpperCase();
        if (paths.has(key)) throw new UploadError("duplicate attachment path");
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_ATTACHMENT_TOTAL_BYTES) callback(new UploadError("attachment exceeds the total size limit", 413));
            else callback(null, chunk);
          }
        });
        await pipeline(part.file, counter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) throw new UploadError("attachment file exceeds the size limit", 413);
        paths.set(key, null);
        fileCount++;
      } catch (error) {
        part.file.destroy();
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UploadError("duplicate attachment path");
        throw error;
      }
    }
    if (!location || !kind || !name || !fileCount) throw new UploadError("attachment must contain at least one file");
    const attachment = { id, name, kind, size, fileCount };
    const stagingManifest = join(location, `${MANIFEST}.tmp`);
    await writeFile(stagingManifest, JSON.stringify(attachment), { flag: "wx", mode: 0o600 });
    await rename(stagingManifest, join(location, MANIFEST));
    committed = true;
    return attachment;
  } finally {
    if (!committed && location && absoluteRoot && dirname(location) === absoluteRoot) {
      await rm(location, { recursive: true, force: true });
    }
  }
}

export function turnAttachmentIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_TURN || value.some(id => typeof id !== "string" || !UUID.test(id))) return null;
  return [...new Set(value.map(id => id.toLowerCase()))];
}

export async function readAttachment(root: string, id: string): Promise<AttachmentReference | null> {
  if (!UUID.test(id)) return null;
  try {
    const location = join(await realpath(root), id);
    const content = join(location, "content");
    const manifest = join(location, MANIFEST);
    if (!(await lstat(location)).isDirectory() || !(await lstat(content)).isDirectory() || !(await lstat(manifest)).isFile()) return null;
    const attachment: Partial<AttachmentSummary> | null = JSON.parse(await readFile(manifest, "utf8"));
    if (attachment?.id !== id || !validName(attachment.name) || !validKind(attachment.kind)) return null;
    const path = join(content, attachment.name);
    const info = await lstat(path);
    if (attachment.kind === "folder" ? !info.isDirectory() : !info.isFile()) return null;
    return { id, name: attachment.name, kind: attachment.kind, path };
  } catch (error) {
    if (error instanceof SyntaxError || ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
