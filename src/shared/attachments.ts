export type AttachmentKind = "file" | "folder";

export interface AttachmentSummary {
  id: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  fileCount: number;
}

export interface AttachmentReference extends Pick<AttachmentSummary, "id" | "name" | "kind"> {
  path: string;
}

export const MAX_ATTACHMENTS_PER_TURN = 10;
export const MAX_ATTACHMENT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 2000;
export const MOBILE_ATTACHMENTS_OPEN = "<mobile-attachments>";
export const MOBILE_ATTACHMENTS_CLOSE = "</mobile-attachments>";
export const MOBILE_ATTACHMENTS_NOTE = "这些是用户上传到 Windows 的附件。按需读取绝对路径；压缩包保持原样。";

export function formatMobileAttachments(attachments: AttachmentReference[]): string {
  const manifest = JSON.stringify(attachments).replaceAll("<", "\\u003c");
  return `${MOBILE_ATTACHMENTS_OPEN}\n${manifest}\n${MOBILE_ATTACHMENTS_CLOSE}\n${MOBILE_ATTACHMENTS_NOTE}`;
}
