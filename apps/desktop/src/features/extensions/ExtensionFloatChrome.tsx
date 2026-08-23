import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

/**
 * Chrome shared by both float containers (extension-deck.md, "Float layer" and
 * "Detached float windows").
 *
 * A float is one presentation whether it is drawn inside the main window or in
 * its own OS window, so its frame must not depend on which container it landed
 * in. Content already renders through one set of renderers; this is the same
 * guarantee for the title bar, which was previously written twice and drifted —
 * different spacing, and a pin that gave hover feedback in one container and
 * none in the other.
 *
 * What legitimately differs stays with each caller: which actions exist. The
 * in-window shell offers the placement list, and the detached window offers
 * re-attach, because a detached float is a thin client that cannot open a menu
 * whose entries write settings.
 */

export function ExtensionFloatTitleBar({
  label,
  onPointerDown,
  onContextMenu,
  children,
}: {
  label: string;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-extension-float-titlebar
      className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-border px-2"
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

export function ExtensionFloatTitleBarButton({
  label,
  icon: Icon,
  dataKey,
  active = false,
  busy = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  /** Marks the control so a keyboard route can anchor a menu to it. */
  dataKey?: string;
  active?: boolean;
  /** Show a spinner in place of the icon while the action is in flight. */
  busy?: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-extension-float-control={dataKey}
      aria-label={label}
      title={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      // Above the shell's own drag layer, and swallowing the pointer press so
      // reaching for a button never starts a window drag.
      className={`relative z-40 flex size-6 items-center justify-center rounded hover:text-foreground disabled:opacity-60 ${
        active ? "text-accent" : "text-muted"
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {busy ? (
        <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Icon size={13} />
      )}
    </button>
  );
}
