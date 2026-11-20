import React, { useState, type ReactNode } from "react";

export type MarkdownTable = {
  headers: string[];
  rows: string[][];
  align: Array<"left" | "center" | "right" | null>;
};

export function parseMarkdownTable(lines: string[]): MarkdownTable | null {
  if (lines.length < 2) return null;
  const headers = splitRow(lines[0] ?? "");
  const separators = splitRow(lines[1] ?? "");
  if (headers.length === 0 || separators.length !== headers.length || !separators.every(isSeparator)) return null;
  const align = separators.map(value => {
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  const rows = lines.slice(2).map(line => {
    const cells = splitRow(line);
    return headers.map((_, index) => cells[index] ?? "");
  });
  return { headers, rows, align };
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of withoutEdges) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    if (character === "\\" && !escaped) {
      escaped = true;
      cell += character;
      continue;
    }
    escaped = false;
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function isSeparator(value: string): boolean {
  return /^:?-{3,}:?$/.test(value.replace(/\s/g, ""));
}

// Only gateway-signed local images render inline; other image URLs stay text.
const SIGNED_IMAGE = /^\/api\/local-images\?t=[\w.%-]+$/;
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^\s)]+)\)\s*$/;
// A Windows or POSIX absolute path, optionally with :line[:col] or #Lline.
const LOCAL_PATH = /^(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|opt|var|etc|tmp|mnt)\/)/;
// Bare paths in prose, e.g. C:\work\app\main.ts:12 (stops at whitespace and CJK punctuation).
const BARE_PATH = /(?<![\w(`[])([A-Za-z]:[\\/][^\s`()<>"'，。；：、！？）】]+)/;
const INLINE_TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]+\]\([^)\n]+\)|cite[\w]*turn\d+\w*|(?<![\w(`[])[A-Za-z]:[\\/][^\s`()<>"'，。；：、！？）】]+)/g;

type PathRef = { path: string; name: string; line: string | null };

export function parseLocalPath(target: string): PathRef | null {
  let raw = target.trim().replace(/^<|>$/g, "");
  if (!LOCAL_PATH.test(raw)) return null;
  raw = raw.replace(/^file:\/\/\/?/, "");
  try { raw = decodeURI(raw); } catch { /* keep the raw path */ }
  let line: string | null = null;
  const hashLine = raw.match(/#L(\d+)(?:-L?(\d+))?$/);
  const colonLine = raw.match(/(?<=\w):(\d+)(?::\d+)?(?:-(\d+))?$/);
  if (hashLine) { line = hashLine[2] ? `${hashLine[1]}-${hashLine[2]}` : hashLine[1] ?? null; raw = raw.slice(0, hashLine.index); }
  else if (colonLine && !/^[A-Za-z]$/.test(raw.slice(0, colonLine.index))) { line = colonLine[2] ? `${colonLine[1]}-${colonLine[2]}` : colonLine[1] ?? null; raw = raw.slice(0, colonLine.index); }
  const trimmed = raw.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() || trimmed;
  return { path: raw, name, line };
}

function PathChip({ refInfo, label }: { refInfo: PathRef; label?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const full = refInfo.line ? `${refInfo.path}:${refInfo.line}` : refInfo.path;
  const isFolder = !/\.[A-Za-z0-9]{1,8}$/.test(refInfo.name);
  const text = label && label !== refInfo.path && label !== full ? label : refInfo.name;
  const copy = () => {
    void navigator.clipboard?.writeText(full).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }, () => undefined);
  };
  return <button type="button" className={`path-chip ${isFolder ? "folder" : "file"} ${copied ? "copied" : ""}`} title={`${full}\n点击复制路径`} onClick={copy}>
    <span className="path-chip-icon" aria-hidden="true">{isFolder ? "▸" : "◇"}</span>
    <span className="path-chip-name">{text}</span>
    {refInfo.line && <span className="path-chip-line">:{refInfo.line}</span>}
    {copied && <span className="path-chip-done">已复制</span>}
  </button>;
}

export function inlineMarkdown(value: string): ReactNode {
  const parts = value.split(INLINE_TOKEN).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const code = part.slice(1, -1);
      const asPath = parseLocalPath(code);
      return asPath ? <PathChip refInfo={asPath} key={index} /> : <code key={index}>{code}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{inlineMarkdown(part.slice(2, -2))}</strong>;
    if (/^cite[\w]*turn\d+\w*$/.test(part)) return null;
    const image = part.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (image) {
      if (SIGNED_IMAGE.test(image[2] ?? "")) return <a className="message-inline-image" href={image[2]} target="_blank" rel="noreferrer" key={index}><img src={image[2]} alt={image[1] ?? ""} loading="lazy" /></a>;
      return <span key={index}>{image[1]}</span>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && link[1] && link[2]) {
      const target = link[2].trim();
      if (/^(https?:\/\/|mailto:)/i.test(target)) return <a href={target} target="_blank" rel="noreferrer" key={index}>{link[1]}</a>;
      const asPath = parseLocalPath(target);
      if (asPath) return <PathChip refInfo={asPath} label={link[1]} key={index} />;
      return <span key={index}>{link[1]}</span>;
    }
    if (BARE_PATH.test(part) && part.match(BARE_PATH)?.[0] === part) {
      const asPath = parseLocalPath(part);
      if (asPath) return <PathChip refInfo={asPath} key={index} />;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

type ListItem = { depth: number; ordered: boolean; start: number; text: string };

function renderList(items: ListItem[], key: string): ReactNode {
  // Group by the shallowest depth; deeper items nest under the previous item.
  const top = Math.min(...items.map(item => item.depth));
  const roots: Array<{ item: ListItem; children: ListItem[] }> = [];
  for (const item of items) {
    const last = roots.at(-1);
    if (item.depth > top && last) last.children.push(item);
    else roots.push({ item, children: [] });
  }
  const ordered = roots[0]?.item.ordered ?? false;
  const body = roots.map((root, index) => <li key={index}>{inlineMarkdown(root.item.text)}{root.children.length > 0 && renderList(root.children, `${key}-${index}`)}</li>);
  return ordered ? <ol key={key} start={roots[0]?.item.start ?? 1}>{body}</ol> : <ul key={key}>{body}</ul>;
}

export function MarkdownMessage({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    while (plain.length && !plain[0]?.trim()) plain.shift();
    while (plain.length && !plain.at(-1)?.trim()) plain.pop();
    if (plain.length === 0) return;
    // Blank lines split paragraphs; single newlines stay as line breaks.
    let paragraph: string[] = [];
    const flushParagraph = () => {
      if (paragraph.length) blocks.push(<p key={`text-${blocks.length}`}>{inlineMarkdown(paragraph.join("\n"))}</p>);
      paragraph = [];
    };
    for (const line of plain) {
      if (!line.trim()) flushParagraph();
      else paragraph.push(line);
    }
    flushParagraph();
    plain = [];
  };
  let index = 0;
  while (index < lines.length) {
    const currentLine = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    // Consecutive image-only lines become one figure grid (report screenshots).
    const imageLine = currentLine.match(IMAGE_LINE);
    if (imageLine && SIGNED_IMAGE.test(imageLine[2] ?? "")) {
      const figures: Array<{ alt: string; src: string }> = [];
      let end = index;
      while (end < lines.length) {
        const line = lines[end] ?? "";
        const match = line.match(IMAGE_LINE);
        if (match && SIGNED_IMAGE.test(match[2] ?? "")) { figures.push({ alt: match[1] ?? "", src: match[2] ?? "" }); end += 1; continue; }
        if (!line.trim() && (lines[end + 1] ?? "").match(IMAGE_LINE)) { end += 1; continue; }
        break;
      }
      flushPlain();
      blocks.push(<div className={`message-figures ${figures.length === 1 ? "single" : ""}`} key={`figures-${blocks.length}`}>{figures.map((figure, figureIndex) => <figure key={figureIndex}><a href={figure.src} target="_blank" rel="noreferrer"><img src={figure.src} alt={figure.alt} loading="lazy" /></a>{figure.alt && <figcaption>{figure.alt}</figcaption>}</figure>)}</div>);
      index = end;
      continue;
    }
    const fence = currentLine.match(FENCE);
    if (fence) {
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      let end = index + 1;
      while (end < lines.length && !(lines[end] ?? "").trim().startsWith(marker)) { code.push(lines[end] ?? ""); end += 1; }
      flushPlain();
      blocks.push(<pre className="message-code" key={`code-${blocks.length}`}>{fence[2] && <span className="message-code-lang">{fence[2]}</span>}<code>{code.join("\n")}</code></pre>);
      index = Math.min(end + 1, lines.length);
      continue;
    }
    const heading = currentLine.match(HEADING);
    if (heading) {
      flushPlain();
      const level = Math.min(4, (heading[1] ?? "#").length);
      const Tag = (["h3", "h3", "h4", "h5"] as const)[level - 1] ?? "h4";
      blocks.push(<Tag className={`message-heading level-${level}`} key={`h-${blocks.length}`}>{inlineMarkdown(heading[2] ?? "")}</Tag>);
      index += 1;
      continue;
    }
    if (RULE.test(currentLine) && !isTableRow(currentLine)) {
      flushPlain();
      blocks.push(<hr className="message-rule" key={`hr-${blocks.length}`} />);
      index += 1;
      continue;
    }
    if (QUOTE.test(currentLine)) {
      const quoted: string[] = [];
      let end = index;
      while (end < lines.length && QUOTE.test(lines[end] ?? "")) { quoted.push((lines[end] ?? "").match(QUOTE)?.[1] ?? ""); end += 1; }
      flushPlain();
      blocks.push(<blockquote className="message-quote" key={`q-${blocks.length}`}>{inlineMarkdown(quoted.join("\n"))}</blockquote>);
      index = end;
      continue;
    }
    if (LIST_ITEM.test(currentLine)) {
      const items: ListItem[] = [];
      let end = index;
      while (end < lines.length) {
        const line = lines[end] ?? "";
        const match = line.match(LIST_ITEM);
        if (match) {
          const marker = match[2] ?? "-";
          items.push({ depth: (match[1] ?? "").replace(/\t/g, "    ").length, ordered: /\d/.test(marker), start: Number.parseInt(marker, 10) || 1, text: match[3] ?? "" });
          end += 1;
          continue;
        }
        // Indented continuation lines belong to the previous item.
        if (line.trim() && /^\s{2,}/.test(line) && items.length) { const last = items.at(-1)!; last.text += `\n${line.trim()}`; end += 1; continue; }
        // A single blank line between items keeps the list together.
        if (!line.trim() && LIST_ITEM.test(lines[end + 1] ?? "")) { end += 1; continue; }
        break;
      }
      flushPlain();
      blocks.push(renderList(items, `list-${blocks.length}`));
      index = end;
      continue;
    }
    if (isTableRow(currentLine) && isTableRow(nextLine)) {
      const tableLines = [currentLine, nextLine];
      let end = index + 2;
      while (end < lines.length && isTableRow(lines[end] ?? "")) {
        tableLines.push(lines[end] ?? "");
        end += 1;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        flushPlain();
        blocks.push(
          <div className="message-table-wrap" key={`table-${blocks.length}`}>
            <table className="message-table">
              <thead><tr>{table.headers.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: table.align[cellIndex] ?? "left" }}>{inlineMarkdown(cell)}</th>)}</tr></thead>
              <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ textAlign: table.align[cellIndex] ?? "left" }}>{inlineMarkdown(cell)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
        index = end;
        continue;
      }
    }
    plain.push(lines[index] ?? "");
    index += 1;
  }
  flushPlain();
  return <div className="message-markdown">{blocks}</div>;
}
