export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

const DIRECT_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface DraftImage {
  id: string;
  name: string;
  blob: Blob;
  previewUrl: string;
}

export async function prepareImageAttachment(file: File): Promise<DraftImage> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const normalizedType = normalizedImageType(file);
  let blob: Blob = file.type ? file : file.slice(0, file.size, normalizedType);
  if (!UPLOAD_TYPES.has(normalizedType) || file.size > DIRECT_UPLOAD_BYTES) {
    blob = await convertToJpeg(file);
  }
  if (blob.size === 0 || blob.size > MAX_IMAGE_UPLOAD_BYTES) throw new Error("图片处理后仍然过大，请选择较小的图片");
  return {
    id: createImageDraftId(),
    name: file.name || "图片",
    blob,
    previewUrl: URL.createObjectURL(blob)
  };
}

export function releaseImageAttachment(image: DraftImage): void {
  URL.revokeObjectURL(image.previewUrl);
}

function normalizedImageType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[extension || ""] || "";
}

async function convertToJpeg(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = document.createElement("img");
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("图片尺寸无效");
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片处理不可用");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const converted = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (!converted) throw new Error("图片转换失败");
    return converted;
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `：${cause.message}` : "";
    throw new Error(`该图片格式暂时无法处理${detail}`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function createImageDraftId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
