export function normalizeThreadCwd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) return null;
  const verbatimPrefix = "\\\\?\\";
  const posixVerbatimPrefix = "//?/";
  const lower = trimmed.toLowerCase();
  const withoutVerbatim = lower.startsWith(verbatimPrefix) ? trimmed.slice(verbatimPrefix.length) : trimmed.startsWith(posixVerbatimPrefix) ? trimmed.slice(posixVerbatimPrefix.length) : trimmed;
  if (!withoutVerbatim) return null;
  const isWindows = /^[A-Za-z]:[\\/]/.test(withoutVerbatim);
  const isUnc = withoutVerbatim.startsWith("\\\\") && withoutVerbatim.slice(2).split(/[\\/]/).filter(Boolean).length >= 2;
  const isPosix = withoutVerbatim.startsWith("/");
  if (!isWindows && !isUnc && !isPosix) return null;
  return withoutVerbatim;
}

export function uniqueThreadCwds(threads: Array<{ cwd?: string | null }>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const thread of threads) {
    const cwd = normalizeThreadCwd(thread.cwd);
    if (!cwd) continue;
    const key = cwd.replaceAll("/", "\\").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cwd);
  }
  return result;
}
