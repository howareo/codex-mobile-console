import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";

const NEAR_BOTTOM_PX = 200;

function nearBottom(): boolean {
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY < NEAR_BOTTOM_PX;
}

// Window-scroll chat follow shared by Codex and Claude: stay pinned to the
// newest output while the reader is at the bottom; once they scroll up, keep
// their position and flag unseen output for the jump button instead.
export function useFollowOutput(bottomRef: RefObject<HTMLElement | null>, version: string, resetKey: string | null) {
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    // Scroll events land a frame late, after images may already have grown the
    // page, so "not near the bottom" alone misreads growth as the reader
    // leaving. Only an actual upward move stops following.
    let lastY = window.scrollY;
    const update = () => {
      const y = window.scrollY;
      const near = nearBottom();
      if (near) following.current = true;
      else if (y < lastY - 2) following.current = false;
      lastY = y;
      setAway(!near);
      if (near) setUnseen(false);
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    following.current = true;
    setUnseen(false);
    const frame = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    // Images and expanding cards finish loading after the first scroll and
    // push the bottom away. While the reader is pinned, re-pin on every growth.
    const container = bottomRef.current?.parentElement;
    let lastHeight = container?.scrollHeight ?? 0;
    const observer = container ? new ResizeObserver(() => {
      const height = container.scrollHeight;
      const grew = height > lastHeight;
      lastHeight = height;
      if (!grew || !following.current || document.documentElement.classList.contains("keyboard-open")) return;
      bottomRef.current?.scrollIntoView({ block: "end" });
    }) : null;
    if (container) observer?.observe(container);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [resetKey, bottomRef]);
  useEffect(() => {
    if (!following.current) { setUnseen(true); return; }
    // Phones only: do not move the page while the on-screen keyboard is up.
    if (document.documentElement.classList.contains("keyboard-open")) return;
    const frame = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [version, bottomRef]);
  const jump = useCallback((smooth = true) => {
    following.current = true;
    setUnseen(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }, [bottomRef]);
  return { away, unseen, jump };
}

export function JumpToLatest({ away, unseen, onJump }: { away: boolean; unseen: boolean; onJump: () => void }) {
  if (!away) return null;
  return <button type="button" className={`jump-latest ${unseen ? "has-new" : ""}`} aria-label={unseen ? "有新输出，回到最新" : "回到最新"} title="回到最新输出" onClick={onJump}>
    <ArrowDown size={16} />{unseen && <span>新输出</span>}
  </button>;
}
