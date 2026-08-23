import type { PresentationHome } from "@pideck/protocol";

export type ExtensionRendererForm = "strip" | "panel" | "list";

/**
 * Renderer form follows family and home (extension-deck.md, Renderer registry):
 * widget renders as a compact strip on anchors and a panel in Dock/Float; status
 * renders as a strip on anchors and a list in Dock.
 */
export function rendererFormFor(
  family: "widget" | "status",
  homeKind: PresentationHome["kind"],
): ExtensionRendererForm {
  if (homeKind === "anchor") return "strip";
  return family === "widget" ? "panel" : "list";
}
