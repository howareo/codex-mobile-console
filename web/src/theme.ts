export type ThemeMode = "auto" | "light" | "dark";

export const THEME_STORAGE_KEY = "codex-mobile-theme";
export const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "日间" },
  { value: "dark", label: "夜间" }
];

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function parseThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

function defaultStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readThemeMode(storage: ThemeStorage | null = defaultStorage()): ThemeMode {
  try {
    return parseThemeMode(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function writeThemeMode(mode: ThemeMode, storage: ThemeStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Private windows and blocked site data: the choice still applies for this session.
  }
}

// "auto" removes the attribute so prefers-color-scheme decides.
export function applyThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;
  syncThemeColor(root);
}

// Keep the browser chrome (address bar, PWA status bar) in step with the page canvas.
export function syncThemeColor(root: HTMLElement = document.documentElement): void {
  const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (canvas && meta) meta.content = canvas;
}
