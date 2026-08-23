import { describe, expect, it } from "vitest";
import type { MonitorDescriptor } from "@pideck/protocol";
import {
  clampRectToMonitor,
  detachedPlacementFor,
  findMonitor,
  monitorForPoint,
  monitorForRect,
  monitorLogicalBounds,
  monitorPlacementBounds,
  resolveDetachedPlacement,
  sameMonitor,
} from "./extension-ui-detached-placement";

/** Rust already converted the built-in Retina panel to logical coordinates. */
const builtin: MonitorDescriptor = {
  name: "Built-in Retina Display",
  position: { x: 0, y: 0 },
  size: { width: 1512, height: 982 },
  scaleFactor: 2,
};

/** External 1080p at 1x, sitting to the right of the built-in panel. */
const external: MonitorDescriptor = {
  name: "DELL U2419H",
  position: { x: 1512, y: 0 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
};

describe("monitorLogicalBounds", () => {
  it("uses the logical bounds supplied by the native monitor boundary", () => {
    expect(monitorLogicalBounds(builtin)).toEqual({ x: 0, y: 0, width: 1512, height: 982 });
    expect(monitorLogicalBounds(external)).toEqual({ x: 1512, y: 0, width: 1920, height: 1080 });
  });

  it("keeps bounds independent from scale metadata", () => {
    expect(monitorLogicalBounds({ ...builtin, scaleFactor: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1512,
      height: 982,
    });
  });
});

describe("monitorPlacementBounds", () => {
  it("uses the work area so a title bar never lands under a menu bar", () => {
    const withMenuBar = { ...builtin, workArea: { x: 0, y: 33, width: 1512, height: 949 } };
    expect(monitorPlacementBounds(withMenuBar)).toEqual({
      x: 0,
      y: 33,
      width: 1512,
      height: 949,
    });
    expect(clampRectToMonitor({ x: 100, y: 0, width: 400, height: 300 }, withMenuBar)).toEqual({
      x: 100,
      y: 33,
      width: 400,
      height: 300,
    });
  });

  it("falls back to the full bounds when the platform reports no work area", () => {
    expect(monitorPlacementBounds(builtin)).toEqual(monitorLogicalBounds(builtin));
  });

  it("keeps identity on the full bounds, so hiding a Dock does not orphan a placement", () => {
    const docked = { ...builtin, workArea: { x: 0, y: 33, width: 1512, height: 869 } };
    const dockHidden = { ...builtin, workArea: { x: 0, y: 33, width: 1512, height: 949 } };
    expect(sameMonitor(docked, dockHidden)).toBe(true);
    expect(findMonitor(docked, [dockHidden])).toBe(dockHidden);
  });
});

describe("sameMonitor", () => {
  it("matches by name even after the display was rearranged", () => {
    expect(sameMonitor(external, { ...external, position: { x: -1920, y: 0 } })).toBe(true);
  });

  it("does not match two different displays that happen to share bounds", () => {
    expect(sameMonitor(external, { ...external, name: "Other" })).toBe(false);
  });

  it("falls back to geometry when neither side reports a name", () => {
    const left = { ...external, name: undefined };
    const right = { ...external, name: undefined };
    expect(sameMonitor(left, right)).toBe(true);
    expect(sameMonitor(left, { ...right, position: { x: 4000, y: 0 } })).toBe(false);
  });

  it("absorbs sub-pixel drift from platform rounding", () => {
    const drifted = { ...external, name: undefined, position: { x: 1512.4, y: -0.3 } };
    expect(sameMonitor({ ...external, name: undefined }, drifted)).toBe(true);
  });
});

describe("findMonitor", () => {
  it("prefers the name match over a geometry match", () => {
    const moved = { ...external, position: { x: 9000, y: 0 } };
    expect(findMonitor(external, [builtin, moved])).toBe(moved);
  });

  it("falls back to geometry when the platform stopped reporting names", () => {
    const unnamed = { ...external, name: undefined };
    expect(findMonitor(external, [builtin, unnamed])).toBe(unnamed);
  });

  it("returns undefined when the display is gone", () => {
    expect(findMonitor(external, [builtin])).toBeUndefined();
  });
});

describe("clampRectToMonitor", () => {
  it("leaves a rect that already fits alone", () => {
    const rect = { x: 1600, y: 100, width: 400, height: 300 };
    expect(clampRectToMonitor(rect, external)).toEqual(rect);
  });

  it("pulls a rect hanging off the right edge back into view", () => {
    expect(clampRectToMonitor({ x: 3300, y: 100, width: 400, height: 300 }, external)).toEqual({
      x: 3032,
      y: 100,
      width: 400,
      height: 300,
    });
  });

  it("pulls a rect hanging off the top-left corner back into view", () => {
    expect(clampRectToMonitor({ x: -500, y: -500, width: 400, height: 300 }, builtin)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it("shrinks an oversized window before clamping so its title bar stays reachable", () => {
    const clamped = clampRectToMonitor({ x: -200, y: -200, width: 5000, height: 4000 }, builtin);
    expect(clamped).toEqual({ x: 0, y: 0, width: 1512, height: 982 });
  });

  it("never shrinks below the minimum usable window size", () => {
    expect(clampRectToMonitor({ x: 1600, y: 100, width: 10, height: 10 }, external)).toEqual({
      x: 1600,
      y: 100,
      width: 200,
      height: 96,
    });
  });
});

describe("resolveDetachedPlacement", () => {
  const placement = { monitor: external, rect: { x: 1600, y: 120, width: 400, height: 300 } };

  it("places the window when its monitor is still present", () => {
    expect(resolveDetachedPlacement(placement, [builtin, external])).toEqual({
      status: "placed",
      monitor: external,
      rect: placement.rect,
    });
  });

  it("reattaches instead of relocating when the monitor is gone", () => {
    expect(resolveDetachedPlacement(placement, [builtin])).toEqual({
      status: "reattach",
      reason: "monitor-missing",
    });
  });

  it("reattaches when no monitor is reported at all", () => {
    expect(resolveDetachedPlacement(placement, [])).toEqual({
      status: "reattach",
      reason: "no-monitors",
    });
  });

  it("clamps into the monitor's new bounds when the display was resized", () => {
    const smaller = { ...external, size: { width: 1280, height: 720 } };
    expect(resolveDetachedPlacement(placement, [builtin, smaller])).toEqual({
      status: "placed",
      monitor: smaller,
      rect: { x: 1600, y: 120, width: 400, height: 300 },
    });
  });

  it("follows the same display through a scale-factor change", () => {
    const retina = { ...external, scaleFactor: 2 };
    const resolved = resolveDetachedPlacement(placement, [builtin, retina]);
    // scaleFactor is metadata here; Rust has already converted the bounds.
    expect(resolved).toEqual({
      status: "placed",
      monitor: retina,
      rect: placement.rect,
    });
  });
});

describe("monitorForPoint", () => {
  it("finds the display under a point", () => {
    expect(monitorForPoint({ x: 100, y: 100 }, [builtin, external])).toBe(builtin);
    expect(monitorForPoint({ x: 2000, y: 100 }, [builtin, external])).toBe(external);
  });

  it("treats the shared edge as belonging to the display that starts there", () => {
    expect(monitorForPoint({ x: 1512, y: 100 }, [builtin, external])).toBe(external);
  });

  it("returns undefined for a point in no display's space", () => {
    expect(monitorForPoint({ x: -100, y: -100 }, [builtin, external])).toBeUndefined();
  });
});

describe("monitorForRect", () => {
  it("picks the display holding most of a straddling rect", () => {
    expect(monitorForRect({ x: 1400, y: 100, width: 400, height: 300 }, [builtin, external])).toBe(
      external,
    );
    expect(monitorForRect({ x: 1200, y: 100, width: 400, height: 300 }, [builtin, external])).toBe(
      builtin,
    );
  });

  it("falls back to a display rather than returning nothing for an off-screen rect", () => {
    expect(monitorForRect({ x: -5000, y: -5000, width: 400, height: 300 }, [builtin])).toBe(
      builtin,
    );
  });

  it("returns undefined only when there is no display at all", () => {
    expect(monitorForRect({ x: 0, y: 0, width: 400, height: 300 }, [])).toBeUndefined();
  });
});

describe("detachedPlacementFor", () => {
  it("records the display the window landed on and clamps into it", () => {
    expect(
      detachedPlacementFor({ x: 3300, y: 100, width: 400, height: 300 }, [builtin, external]),
    ).toEqual({ monitor: external, rect: { x: 3032, y: 100, width: 400, height: 300 } });
  });

  it("declines to build a placement with no display, leaving the Float attached", () => {
    expect(detachedPlacementFor({ x: 0, y: 0, width: 400, height: 300 }, [])).toBeUndefined();
  });
});
