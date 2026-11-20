import { createHmac, timingSafeEqual } from "node:crypto";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MAX_TOKEN_CHARS = 2048;

export function localImageAbsolutePath(value: string): string | null {
  let raw = value.trim();
  if (!raw || raw.includes("\0")) return null;
  if (raw.startsWith("file:")) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  raw = raw.replace(/^\\\\\?\\/, "").replace(/^\uFEFF/, "");
  if (!isAbsolute(raw)) return null;
  const resolved = resolve(raw);
  if (!IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) return null;
  return resolved;
}

export function signLocalImageToken(absolutePath: string, secret: string): string {
  const payload = Buffer.from(absolutePath, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(absolutePath).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyLocalImageToken(token: string, secret: string): string | null {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  let absolutePath: string;
  try {
    absolutePath = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(absolutePath).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const resolved = localImageAbsolutePath(absolutePath);
  return resolved === absolutePath ? resolved : null;
}

export function localImagePublicName(absolutePath: string): string {
  return basename(absolutePath);
}

// Agent replies embed local screenshots as Markdown images, e.g.
// ![总览](C:/work/out.png). Swap each existing local image path for a signed
// gateway URL so the phone can show it without seeing the Windows path.
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
export function signMarkdownLocalImages(text: string, secret: string, exists: (path: string) => boolean): string {
  if (!text.includes("![")) return text;
  return text.replace(MARKDOWN_IMAGE, (match, alt: string, target: string) => {
    const absolute = localImageAbsolutePath(target.trim().replace(/^<|>$/g, ""));
    if (!absolute || !exists(absolute)) return match;
    return `![${alt}](/api/local-images?t=${signLocalImageToken(absolute, secret)})`;
  });
}

export function isCodexImageItemType(type: string): boolean {
  return type === "imageView" || type === "ImageView" || type === "imageGeneration" || type === "ImageGeneration";
}

export function codexImageSourcePath(item: { type?: unknown; path?: unknown; savedPath?: unknown }): string | null {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "imageGeneration" || type === "ImageGeneration") {
    return typeof item.savedPath === "string" ? item.savedPath : null;
  }
  if (type === "imageView" || type === "ImageView") {
    return typeof item.path === "string" ? item.path : null;
  }
  return null;
}
