// Product marks drawn for this console: each agent gets a filled tile in its
// own colour so the two entries read apart at a glance; utility entries stay
// line icons that share the same 24px grid and 2px stroke.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number, props: SVGProps<SVGSVGElement>) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true as const, focusable: false as const, ...props
});

/** Codex: the familiar blue tile with a white interlaced rosette. */
export function CodexMark({ size = 22, ...props }: IconProps) {
  const links = [0, 60, 120];
  return <svg {...base(size, props)} className={`agent-mark codex-mark ${props.className ?? ""}`}>
    <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="var(--mark-codex-bg)" />
    <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="url(#codex-sheen)" />
    <g stroke="var(--mark-codex-ink)" strokeWidth="1.6" fill="none">
      {links.map(angle => <rect key={angle} x="9.3" y="5.6" width="5.4" height="12.8" rx="2.7" transform={`rotate(${angle} 12 12)`} />)}
    </g>
    <defs><linearGradient id="codex-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".22" /><stop offset=".55" stopColor="#fff" stopOpacity="0" /></linearGradient></defs>
  </svg>;
}

/** Claude: a soft eight-point spark, the shape people already associate with it. */
export function ClaudeMark({ size = 22, ...props }: IconProps) {
  const rays = [0, 45, 90, 135];
  return <svg {...base(size, props)} className={`agent-mark claude-mark ${props.className ?? ""}`}>
    <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="var(--mark-claude-bg)" />
    <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="url(#claude-sheen)" />
    <g stroke="var(--mark-claude-ink)" strokeWidth="2.1" strokeLinecap="round">
      {rays.map(angle => <path key={angle} d="M12 6.4v11.2" transform={`rotate(${angle} 12 12)`} />)}
    </g>
    <circle cx="12" cy="12" r="1.9" fill="var(--mark-claude-bg)" />
    <defs><linearGradient id="claude-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".3" /><stop offset=".55" stopColor="#fff" stopOpacity="0" /></linearGradient></defs>
  </svg>;
}

/** Live: a pulse line inside concentric signal arcs. */
export function LiveIcon({ size = 22, ...props }: IconProps) {
  return <svg {...base(size, props)} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 12h3.2l2-4.6 3.6 9.2 2.3-6.2 1.4 1.6h4.5" />
    <path d="M5.6 5.6a9 9 0 0 1 12.8 0" opacity=".45" />
    <path d="M5.6 18.4a9 9 0 0 0 12.8 0" opacity=".45" />
  </svg>;
}

/** Settings: three sliders, lighter and more legible than a gear at 20px. */
export function SettingsIcon({ size = 22, ...props }: IconProps) {
  return <svg {...base(size, props)} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 7h7M17 7h3M4 17h3M13 17h7" />
    <circle cx="14" cy="7" r="2.6" />
    <circle cx="10" cy="17" r="2.6" />
  </svg>;
}

/** App logo: two overlapping tiles, Codex in front and Claude behind. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" focusable="false" className="brand-logo">
    <defs>
      <linearGradient id="brand-front" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--accent-strong)" /><stop offset="1" stopColor="var(--accent)" /></linearGradient>
      <linearGradient id="brand-back" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c9b6ff" /><stop offset="1" stopColor="#7b5cf0" /></linearGradient>
    </defs>
    <rect x="12" y="2" width="22" height="22" rx="7" fill="url(#brand-back)" opacity=".92" />
    <rect x="2" y="11" width="23" height="23" rx="7.5" fill="url(#brand-front)" stroke="var(--canvas)" strokeWidth="2" />
    <path d="M8.2 18.6 11.8 22.5 8.2 26.4" stroke="var(--accent-ink)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 26.6h5" stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinecap="round" />
  </svg>;
}
