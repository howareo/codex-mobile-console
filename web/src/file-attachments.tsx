import React, { useRef, useState } from "react";
import { File as FileIcon, FolderClosed, ImagePlus, Paperclip, X } from "lucide-react";
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENT_FILES, MOBILE_ATTACHMENTS_NOTE, type AttachmentSummary } from "../../src/shared/attachments";

export interface DraftAttachment {
  id: string;
  name: string;
  kind: "file" | "folder";
  files: Array<{ path: string; file: File }>;
  size: number;
  uploaded?: AttachmentSummary;
}

export function fileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function createAttachmentDrafts(files: File[], folder = false): DraftAttachment[] {
  if (!files.length) throw new Error("文件夹中没有可上传的文件");
  const groups = new Map<string, DraftAttachment>();
  for (const file of files) {
    const relative = folder ? file.webkitRelativePath : "";
    const name = relative ? relative.split("/")[0]! : file.name;
    const key = relative ? name : `file-${groups.size}`;
    let draft = groups.get(key);
    if (!draft) {
      draft = { id: crypto.randomUUID(), name, kind: relative ? "folder" : "file", files: [], size: 0 };
      groups.set(key, draft);
    }
    draft.files.push({ path: relative ? relative.slice(name.length + 1) : file.name, file });
    draft.size += file.size;
  }
  const drafts = [...groups.values()];
  validateAttachmentDrafts(drafts);
  return drafts;
}

export function validateAttachmentDrafts(drafts: DraftAttachment[]): void {
  if (drafts.length > MAX_ATTACHMENTS_PER_TURN) throw new Error(`每条消息最多 ${MAX_ATTACHMENTS_PER_TURN} 个文件或文件夹`);
  for (const draft of drafts) {
    if (draft.files.length > MAX_ATTACHMENT_FILES) throw new Error(`每个文件夹最多 ${MAX_ATTACHMENT_FILES} 个文件`);
    if (draft.size > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`单个附件总大小最多 ${fileSize(MAX_ATTACHMENT_TOTAL_BYTES)}`);
    if (draft.files.some(entry => entry.file.size > MAX_ATTACHMENT_FILE_BYTES)) throw new Error(`单个文件最多 ${fileSize(MAX_ATTACHMENT_FILE_BYTES)}`);
  }
}

export async function attachmentsFromDrop(data: DataTransfer): Promise<DraftAttachment[]> {
  const items = Array.from(data.items || []);
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length) return createAttachmentDrafts(Array.from(data.files));
  const drafts: DraftAttachment[] = [];
  for (const root of entries) {
    const draft: DraftAttachment = { id: crypto.randomUUID(), name: root.name, kind: root.isDirectory ? "folder" : "file", files: [], size: 0 };
    const visit = async (entry: FileSystemEntry, path: string, depth: number): Promise<void> => {
      if (depth > 32) throw new Error("文件夹层级过深，请压缩后上传");
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        draft.files.push({ path, file });
        draft.size += file.size;
        validateAttachmentDrafts([draft]);
      } else {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        while (true) {
          const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await visit(child, path ? `${path}/${child.name}` : child.name, depth + 1);
        }
      }
    };
    await visit(root, root.isDirectory ? "" : root.name, 0);
    if (!draft.files.length) throw new Error(`“${draft.name}”是空文件夹，请选择包含文件的目录`);
    drafts.push(draft);
    validateAttachmentDrafts(drafts);
  }
  return drafts;
}

export function uploadAttachment(draft: DraftAttachment, onProgress: (label: string) => void): Promise<AttachmentSummary> {
  if (draft.uploaded) return Promise.resolve(draft.uploaded);
  const data = new FormData();
  data.append("kind", draft.kind);
  data.append("name", draft.name);
  for (const entry of draft.files) data.append(`file:${entry.path}`, entry.file, entry.file.name);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/attachments");
    request.withCredentials = true;
    request.timeout = 10 * 60 * 1000;
    request.upload.onprogress = event => onProgress(`正在上传 ${draft.name}${event.lengthComputable ? ` · ${Math.min(100, Math.round(event.loaded * 100 / event.total))}%` : ""}`);
    request.onerror = () => reject(new Error("附件上传连接中断，文件仍保留在输入框中，请重试"));
    request.ontimeout = () => reject(new Error("附件上传超时，文件仍保留在输入框中，请重试"));
    request.onabort = () => reject(new Error("附件上传已取消"));
    request.onload = () => {
      let result: { attachment?: AttachmentSummary; error?: string };
      try { result = JSON.parse(request.responseText); }
      catch { reject(new Error(`附件上传失败（HTTP ${request.status}）`)); return; }
      if (request.status < 200 || request.status >= 300 || !result.attachment) { reject(new Error(result.error || `附件上传失败（HTTP ${request.status}）`)); return; }
      draft.uploaded = result.attachment;
      resolve(result.attachment);
    };
    onProgress(`正在上传 ${draft.name}`);
    request.send(data);
  });
}

export function AttachmentPicker({ busy, onImages, onFiles, onError }: {
  busy: boolean; onImages: (files: FileList | null) => void; onFiles: (files: File[], folder: boolean) => void; onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const choose = (input: HTMLInputElement | null) => { setOpen(false); input?.click(); };
  return <div className="attachment-picker">
    <button type="button" className="composer-button utility" title="添加附件" aria-label="添加附件" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}><Paperclip size={18} /></button>
    {open && <><button type="button" className="attachment-dismiss" aria-label="关闭附件菜单" onClick={() => setOpen(false)} /><div className="attachment-menu">
      <button type="button" onClick={() => choose(imageInput.current)}><ImagePlus size={17} />照片或图片</button>
      <button type="button" onClick={() => choose(fileInput.current)}><FileIcon size={17} />文件或压缩包</button>
      <button type="button" onClick={() => {
        if (folderInput.current && "webkitdirectory" in folderInput.current) choose(folderInput.current);
        else { setOpen(false); onError("当前浏览器不支持选择文件夹，请将文件夹压缩为 ZIP 后上传"); }
      }}><FolderClosed size={17} />文件夹</button>
    </div></>}
    <input ref={imageInput} className="composer-file-input" type="file" accept="image/*,image/heic,image/heif,.heic,.heif" multiple disabled={busy} onChange={event => { onImages(event.currentTarget.files); event.currentTarget.value = ""; }} />
    <input ref={fileInput} className="composer-file-input" type="file" multiple disabled={busy} onChange={event => { onFiles(Array.from(event.currentTarget.files || []), false); event.currentTarget.value = ""; }} />
    <input ref={node => { folderInput.current = node; node?.setAttribute("webkitdirectory", ""); }} className="composer-file-input" type="file" multiple disabled={busy} onChange={event => { onFiles(Array.from(event.currentTarget.files || []), true); event.currentTarget.value = ""; }} />
  </div>;
}

export function AttachmentDrafts({ drafts, busy, onRemove }: { drafts: DraftAttachment[]; busy: boolean; onRemove: (id: string) => void }) {
  return <div className="composer-attachments" aria-label="待发送文件">{drafts.map(draft => <div className="attachment-chip" key={draft.id}>
    {draft.kind === "folder" ? <FolderClosed size={17} /> : <FileIcon size={17} />}
    <span><strong title={draft.name}>{draft.name}</strong><small>{draft.kind === "folder" ? `${draft.files.length} 个文件 · ` : ""}{fileSize(draft.size)}</small></span>
    <button type="button" disabled={busy} aria-label={`移除 ${draft.name}`} onClick={() => onRemove(draft.id)}><X size={14} /></button>
  </div>)}</div>;
}

export function parseAttachmentMessage(text: string): { text: string; attachments: Array<{ id: string; name: string; kind: string }> } {
  const attachments: Array<{ id: string; name: string; kind: string }> = [];
  const note = MOBILE_ATTACHMENTS_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<mobile-attachments>\\s*([\\s\\S]*?)\\s*</mobile-attachments>(?:\\r?\\n${note})?`, "g");
  const cleaned = text.replace(pattern, (block, json: string) => {
    try {
      const entries: unknown = JSON.parse(json);
      if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ATTACHMENTS_PER_TURN) return block;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.name !== "string" || !["file", "folder"].includes(entry.kind)) return block;
      }
      attachments.push(...entries.map(entry => ({ id: entry.id, name: entry.name, kind: entry.kind })));
      return "";
    } catch { return block; }
  });
  return { text: cleaned.trim(), attachments };
}
