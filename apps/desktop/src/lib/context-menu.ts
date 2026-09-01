import type { LucideIcon } from "lucide-react";

export type MenuItem = {
  id: string;
  label: string;
  icon?: LucideIcon;
  chordHint?: string;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
};

export type ContextMenuInput = {
  x: number;
  y: number;
  trigger: HTMLElement | null;
  density?: "default" | "compact";
  items: MenuItem[];
};

export type ContextMenuRequest = ContextMenuInput & { requestId: number };

type Listener = (request: ContextMenuRequest | null) => void;
const listeners = new Set<Listener>();
let current: ContextMenuRequest | null = null;
let nextRequestId = 1;

export function subscribeContextMenu(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function openContextMenu(request: ContextMenuInput): void {
  current = request.items.length > 0 ? { ...request, requestId: nextRequestId++ } : null;
  for (const listener of listeners) listener(current);
}

export function closeContextMenu(): void {
  if (!current) return;
  current = null;
  for (const listener of listeners) listener(null);
}

export function contextMenuTrigger(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}
