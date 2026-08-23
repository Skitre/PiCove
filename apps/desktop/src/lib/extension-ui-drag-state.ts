import { useSyncExternalStore } from "react";
import type { ExtensionSurfaceFamily } from "@pideck/protocol";

/** Transient Extension drag-in-progress state. In-memory only, never persisted. */
export type ActiveExtensionUiDrag = {
  slotId: string;
  family: Exclude<ExtensionSurfaceFamily, "blockingDialog">;
};

let active: ActiveExtensionUiDrag | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function beginExtensionUiDrag(drag: ActiveExtensionUiDrag): void {
  if (active?.slotId === drag.slotId && active.family === drag.family) return;
  active = drag;
  emit();
}

export function endExtensionUiDrag(): void {
  if (!active) return;
  active = null;
  emit();
}

export function getActiveExtensionUiDrag(): ActiveExtensionUiDrag | null {
  return active;
}

export function subscribeExtensionUiDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Legal `data-extension-drop` targets for the dragged family. */
export function isLegalExtensionDropTarget(
  drag: ActiveExtensionUiDrag | null,
  drop: string,
): boolean {
  if (!drag) return false;
  if (drop === "dock-primary" || drop === "dock-secondary") {
    return drag.family === "widget" || drag.family === "custom";
  }
  if (drop === "aboveComposer" || drop === "belowComposer") {
    return drag.family === "widget";
  }
  return false;
}

export function useExtensionDropHighlight(drop: string): boolean {
  return isLegalExtensionDropTarget(
    useSyncExternalStore(subscribeExtensionUiDrag, getActiveExtensionUiDrag, () => null),
    drop,
  );
}

export function resetExtensionUiDragForTests(): void {
  if (!active) return;
  active = null;
  emit();
}
