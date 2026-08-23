import { useSyncExternalStore } from "react";

/**
 * Which float slots currently have an OS window of their own
 * (extension-deck.md, "Detached float windows").
 *
 * A float's home says where it wants to live; whether a window actually exists
 * is a runtime fact only the window controller knows. The display it was placed
 * on may be unplugged, the platform may refuse, or there may be no desktop
 * runtime at all. The in-window float layer draws exactly the floats that are
 * missing from this set, so a float is never simply invisible.
 *
 * Deliberately not a stored preference. Losing a display must not rewrite where
 * the user put a window — the placement is kept exactly as it was, and the
 * window reopens there when the display comes back.
 */

let windowed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function sameMembership(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** Publish the full set; any float absent from it is drawn in the main window. */
export function setWindowedFloats(next: Iterable<string>): void {
  const value = new Set(next);
  if (sameMembership(windowed, value)) return;
  windowed = value;
  for (const listener of listeners) listener();
}

export function getWindowedFloats(): ReadonlySet<string> {
  return windowed;
}

export function subscribeWindowedFloats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWindowedFloats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWindowedFloats, getWindowedFloats, getWindowedFloats);
}

export function resetWindowedFloatsForTests(): void {
  if (windowed.size === 0) return;
  windowed = new Set();
  for (const listener of listeners) listener();
}
