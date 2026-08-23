import type {
  DetachedFloatPlacement,
  MonitorDescriptor,
  PresentationHome,
  ScreenRect,
} from "@pideck/protocol";
import { detachedPlacementFor } from "./extension-ui-detached-placement";
import { listFloatMonitors } from "./extension-float-transport";

/**
 * Turning an attached Float into a detached one: where should its window go?
 *
 * The honest answer is "exactly where the user is already looking at it", so
 * the placement comes from the Float's own on-screen rectangle rather than a
 * fixed offset. S1 measured that a webview's client-area origin is a stable
 * offset from screen coordinates, which is what makes this conversion sound.
 */

/** The main window's client-area origin, in logical screen pixels. */
async function clientOriginOnScreen(): Promise<{ x: number; y: number }> {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  // screenX/screenY already describe the client area, so no title-bar
  // correction is needed. They read 0 in some embeddings; fall back to the
  // platform's own window position there.
  if (window.screenX !== 0 || window.screenY !== 0) {
    return { x: window.screenX, y: window.screenY };
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = getCurrentWindow();
    const [position, scale] = await Promise.all([current.outerPosition(), current.scaleFactor()]);
    const factor = scale > 0 ? scale : 1;
    return { x: position.x / factor, y: position.y / factor };
  } catch {
    return { x: 0, y: 0 };
  }
}

export type ViewportRect = { left: number; top: number; width: number; height: number };

async function screenRectForViewportRect(rect: ViewportRect): Promise<ScreenRect> {
  const origin = await clientOriginOnScreen();
  return {
    x: origin.x + rect.left,
    y: origin.y + rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Where a Float drawn at `rect` inside the main window would land on screen.
 * Takes the monitor list rather than reading it, so a caller that already
 * enumerated displays does not pay for it twice.
 */
export async function detachedPlacementForViewportRect(
  rect: ViewportRect,
  monitors: MonitorDescriptor[],
): Promise<DetachedFloatPlacement | undefined> {
  if (monitors.length === 0) return undefined;
  return detachedPlacementFor(await screenRectForViewportRect(rect), monitors) ?? undefined;
}

/**
 * Build the detached home for a Float that is currently drawn at `rect` inside
 * the main window. Returns undefined when no display can host it, which leaves
 * the Float attached rather than opening a window nobody can see.
 */
export async function detachedHomeForViewportRect(
  home: Extract<PresentationHome, { kind: "float" }>,
  rect: ViewportRect,
): Promise<PresentationHome | undefined> {
  const placement = await detachedPlacementForViewportRect(rect, (await listFloatMonitors()) ?? []);
  if (!placement) return undefined;
  return { ...home, detached: placement };
}
