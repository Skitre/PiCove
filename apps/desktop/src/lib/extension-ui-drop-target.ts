import type { PresentationHome } from "@pideck/protocol";

/** Resolve the `[data-extension-drop]` element under a pointer into a presentation home. */
export function homeFromDropTarget(target: EventTarget | null): PresentationHome | null {
  const element =
    target instanceof Element ? target.closest<HTMLElement>("[data-extension-drop]") : null;
  const drop = element?.dataset.extensionDrop;
  if (drop === "dock-primary") return { kind: "dock", group: "primary", order: 0 };
  if (drop === "dock-secondary") return { kind: "dock", group: "secondary", order: 0 };
  if (drop === "aboveComposer") return { kind: "anchor", slot: "aboveComposer" };
  if (drop === "belowComposer") return { kind: "anchor", slot: "belowComposer" };
  return null;
}
