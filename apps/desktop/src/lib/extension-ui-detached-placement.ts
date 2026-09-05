import type { DetachedFloatPlacement, MonitorDescriptor, ScreenRect } from "@pideck/protocol";

/**
 * Detached Float placement geometry (extension-deck.md, "Detached placement and
 * monitor recovery"). Stored placements and descriptors retain their original
 * monitor-scaled logical format. Windows native geometry uses physical desktop
 * pixels: only those coordinates form one space across differently scaled
 * displays. Convert after selecting a monitor, never before comparing monitors.
 *
 * Pure functions only. A detached Float is positioned from these results; none
 * of them touch a window, the DOM, or settings.
 */

/** A detached window must stay large enough to show its own title bar and body. */
const DETACHED_MIN_WIDTH = 200;
const DETACHED_MIN_HEIGHT = 96;

/**
 * Geometry matching tolerance, in logical pixels. Scale-factor division and
 * platform rounding move reported bounds by a fraction of a pixel between
 * launches; a whole pixel of slack absorbs that without merging two displays
 * that genuinely sit a pixel apart.
 */
const MONITOR_MATCH_TOLERANCE = 1;

export type Point = { x: number; y: number };
type ScreenCoordinateSpace = "logical" | "physical";

function scaleRect(rect: ScreenRect, factor: number): ScreenRect {
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

function coordinateScale(monitor: MonitorDescriptor, space: ScreenCoordinateSpace): number {
  return space === "physical" && monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
}

export type DetachedPlacementResolution =
  | { status: "placed"; monitor: MonitorDescriptor; rect: ScreenRect }
  | { status: "reattach"; reason: "no-monitors" | "monitor-missing" };

/** The monitor's own bounds, in the same logical space as a detached rect. */
export function monitorLogicalBounds(monitor: MonitorDescriptor): ScreenRect {
  return {
    x: monitor.position.x,
    y: monitor.position.y,
    width: monitor.size.width,
    height: monitor.size.height,
  };
}

/**
 * Where a window may actually sit. The work area excludes a menu bar, taskbar,
 * or Dock; clamping to the full bounds instead would happily park a title bar
 * underneath one, producing the unreachable window the clamp exists to prevent.
 * Falls back to the full bounds when the platform reports no work area.
 */
export function monitorPlacementBounds(monitor: MonitorDescriptor): ScreenRect {
  return monitor.workArea ?? monitorLogicalBounds(monitor);
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= MONITOR_MATCH_TOLERANCE;
}

/**
 * Whether two descriptors denote the same display. Name wins when both report
 * one: a display that moved or was rearranged is still that display. Geometry
 * is the fallback for platforms that report no stable name.
 */
export function sameMonitor(left: MonitorDescriptor, right: MonitorDescriptor): boolean {
  if (left.name && right.name) return left.name === right.name;
  const a = monitorLogicalBounds(left);
  const b = monitorLogicalBounds(right);
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

/**
 * Resolve a stored descriptor against the live monitor set: by name first, then
 * by geometry. A named descriptor that finds no name match still falls back to
 * geometry, because a platform may stop reporting names across an update.
 */
export function findMonitor(
  stored: MonitorDescriptor,
  available: readonly MonitorDescriptor[],
): MonitorDescriptor | undefined {
  if (stored.name) {
    const byName = available.find((monitor) => monitor.name === stored.name);
    if (byName) return byName;
  }
  return available.find((monitor) => {
    const a = monitorLogicalBounds(stored);
    const b = monitorLogicalBounds(monitor);
    return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
  });
}

/**
 * Keep a detached window fully inside its monitor. A window wider or taller
 * than the display is shrunk first, so clamping the origin can never push its
 * title bar off-screen and leave the window unreachable.
 */
export function clampRectToMonitor(rect: ScreenRect, monitor: MonitorDescriptor): ScreenRect {
  const bounds = monitorPlacementBounds(monitor);
  const width = Math.min(Math.max(DETACHED_MIN_WIDTH, rect.width), Math.max(1, bounds.width));
  const height = Math.min(Math.max(DETACHED_MIN_HEIGHT, rect.height), Math.max(1, bounds.height));
  const maxX = bounds.x + bounds.width - width;
  const maxY = bounds.y + bounds.height - height;
  return {
    x: Math.min(Math.max(bounds.x, rect.x), Math.max(bounds.x, maxX)),
    y: Math.min(Math.max(bounds.y, rect.y), Math.max(bounds.y, maxY)),
    width,
    height,
  };
}

/**
 * Decide where a stored placement goes on this launch.
 *
 * A placement whose monitor is absent reattaches the Float to the main window
 * rather than being clamped onto a different display: silently relocating it
 * loses the user's actual choice, while reattaching is visible and recoverable.
 */
export function resolveDetachedPlacement(
  placement: DetachedFloatPlacement,
  available: readonly MonitorDescriptor[],
  space: ScreenCoordinateSpace = "logical",
): DetachedPlacementResolution {
  if (available.length === 0) return { status: "reattach", reason: "no-monitors" };
  const monitor = findMonitor(placement.monitor, available);
  if (!monitor) return { status: "reattach", reason: "monitor-missing" };
  const localRect = {
    ...placement.rect,
    x: monitor.position.x + placement.rect.x - placement.monitor.position.x,
    y: monitor.position.y + placement.rect.y - placement.monitor.position.y,
  };
  return {
    status: "placed",
    monitor,
    rect: scaleRect(clampRectToMonitor(localRect, monitor), coordinateScale(monitor, space)),
  };
}

function containsPoint(bounds: ScreenRect, point: Point): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

/** The monitor under a screen point, for deciding where a new detached window lands. */
export function monitorForPoint(
  point: Point,
  available: readonly MonitorDescriptor[],
  space: ScreenCoordinateSpace = "logical",
): MonitorDescriptor | undefined {
  return available.find((monitor) =>
    containsPoint(scaleRect(monitorLogicalBounds(monitor), coordinateScale(monitor, space)), point),
  );
}

function overlapArea(left: ScreenRect, right: ScreenRect): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The monitor a rect belongs to: the one it overlaps most, falling back to the
 * one under its centre and finally to the first available. A rect straddling
 * two displays has to pick one, and "mostly here" matches what the user sees.
 */
export function monitorForRect(
  rect: ScreenRect,
  available: readonly MonitorDescriptor[],
  space: ScreenCoordinateSpace = "logical",
): MonitorDescriptor | undefined {
  let best: { monitor: MonitorDescriptor; area: number } | undefined;
  for (const monitor of available) {
    const area = overlapArea(
      rect,
      scaleRect(monitorLogicalBounds(monitor), coordinateScale(monitor, space)),
    );
    if (area > 0 && (!best || area > best.area)) best = { monitor, area };
  }
  if (best) return best.monitor;
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  return monitorForPoint(centre, available, space) ?? available[0];
}

/**
 * Build a storable placement for a rect the user just put somewhere. Returns
 * undefined when no monitor is available, which leaves the Float attached.
 */
export function detachedPlacementFor(
  rect: ScreenRect,
  available: readonly MonitorDescriptor[],
  space: ScreenCoordinateSpace = "logical",
): DetachedFloatPlacement | undefined {
  const monitor = monitorForRect(rect, available, space);
  if (!monitor) return undefined;
  return {
    monitor,
    rect: clampRectToMonitor(scaleRect(rect, 1 / coordinateScale(monitor, space)), monitor),
  };
}
