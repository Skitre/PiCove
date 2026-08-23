import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginExtensionUiDrag,
  endExtensionUiDrag,
  getActiveExtensionUiDrag,
  isLegalExtensionDropTarget,
  resetExtensionUiDragForTests,
  subscribeExtensionUiDrag,
} from "./extension-ui-drag-state";

afterEach(() => resetExtensionUiDragForTests());

describe("extension drag state", () => {
  it("stores the active drag and notifies subscribers only on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeExtensionUiDrag(listener);
    expect(getActiveExtensionUiDrag()).toBeNull();

    beginExtensionUiDrag({ slotId: "pi-subagents:widget", family: "widget" });
    expect(getActiveExtensionUiDrag()).toEqual({ slotId: "pi-subagents:widget", family: "widget" });
    expect(listener).toHaveBeenCalledTimes(1);

    beginExtensionUiDrag({ slotId: "pi-subagents:widget", family: "widget" });
    expect(listener).toHaveBeenCalledTimes(1);

    endExtensionUiDrag();
    expect(getActiveExtensionUiDrag()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    endExtensionUiDrag();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("marks anchors and both dock groups as targets for a widget drag", () => {
    beginExtensionUiDrag({ slotId: "pi-subagents:widget", family: "widget" });
    for (const drop of ["aboveComposer", "belowComposer", "dock-primary", "dock-secondary"]) {
      expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), drop)).toBe(true);
    }
    expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), "unknown")).toBe(false);
  });

  it("marks only dock groups as targets for a custom drag", () => {
    beginExtensionUiDrag({ slotId: "pi-subagents:custom", family: "custom" });
    expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), "dock-primary")).toBe(true);
    expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), "dock-secondary")).toBe(true);
    expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), "aboveComposer")).toBe(false);
    expect(isLegalExtensionDropTarget(getActiveExtensionUiDrag(), "belowComposer")).toBe(false);
  });

  it("treats no active drag as no legal target", () => {
    expect(isLegalExtensionDropTarget(null, "dock-primary")).toBe(false);
  });
});
