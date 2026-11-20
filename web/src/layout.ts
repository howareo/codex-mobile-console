import { useCallback, useSyncExternalStore } from "react";

// Keep these in step with the @media breakpoints in styles.css.
// Desktop: icon rail + pinned task list + centered conversation.
export const DESKTOP_QUERY = "(min-width: 1100px)";
// Wide: the right-hand inspector column appears next to the conversation.
export const WIDE_QUERY = "(min-width: 1280px)";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
