import { useSyncExternalStore } from "react";

/**
 * Viewport width at and above which the side panel shows the permanent scope
 * column instead of the scope drawer. A side panel's viewport width IS the
 * panel width, so `matchMedia` tracks the user resizing the panel.
 */
export const WIDE_QUERY = "(min-width: 640px)";

function hasMatchMedia(): boolean {
  return typeof globalThis.matchMedia === "function";
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = globalThis.matchMedia(WIDE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  // No matchMedia (jsdom, tests): render the fuller wide layout.
  return hasMatchMedia() ? globalThis.matchMedia(WIDE_QUERY).matches : true;
}

/** True when the panel is wide enough for the permanent scope column. */
export function useIsWide(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
