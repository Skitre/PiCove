import { useEffect } from "react";
import { ClipboardCopy } from "lucide-react";
import { contextMenuTrigger, openContextMenu } from "./context-menu";
import { resolveTextMenuTarget, buildTextContextMenuItems } from "./text-context-menu";
import { useT } from "./i18n/use-t";

export function shouldKeepNativeContextMenu(
  event: Pick<MouseEvent, "shiftKey" | "target">,
  dev = import.meta.env.DEV,
): boolean {
  return Boolean(
    (dev && event.shiftKey) ||
    (event.target instanceof Element && event.target.closest("[data-tauri-drag-region]")),
  );
}

export function shouldOpenFallbackContextMenu(
  event: Pick<MouseEvent, "defaultPrevented" | "shiftKey" | "target">,
  dev = import.meta.env.DEV,
): boolean {
  return !event.defaultPrevented && !shouldKeepNativeContextMenu(event, dev);
}

export function ContextMenuPolicy() {
  const t = useT();
  useEffect(() => {
    const openFallback = (event: MouseEvent) => {
      // Feature-owned context menus run before this window fallback. Respect
      // their cancellation instead of opening a second menu on top.
      if (!shouldOpenFallbackContextMenu(event)) return;
      event.preventDefault();
      const textTarget = resolveTextMenuTarget(event.target);
      if (textTarget) {
        openContextMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: contextMenuTrigger(event.target),
          items: buildTextContextMenuItems(textTarget, t),
        });
        return;
      }
      const selection = window.getSelection()?.toString() ?? "";
      if (!selection) return;
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        trigger: contextMenuTrigger(event.target),
        items: [
          {
            id: "selection.copy",
            label: t("menuCopySelection"),
            icon: ClipboardCopy,
            onSelect: () => navigator.clipboard.writeText(selection),
          },
        ],
      });
    };
    window.addEventListener("contextmenu", openFallback);
    return () => {
      window.removeEventListener("contextmenu", openFallback);
    };
  }, [t]);
  return null;
}
