/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { homeFromDropTarget } from "./extension-ui-drop-target";

describe("homeFromDropTarget", () => {
  it("resolves the closest drop element for each named target", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-extension-drop="dock-primary"><span data-extension-dock-edge="secondary"></span></div>
      <div data-extension-drop="dock-secondary"></div>
      <div data-extension-drop="aboveComposer"><button>row</button></div>
      <div data-extension-drop="belowComposer"></div>
      <div>plain</div>
    `;
    const [dockPrimary, dockSecondary, above, below, plain] = [...root.children];
    expect(homeFromDropTarget(dockPrimary.firstElementChild)).toEqual({
      kind: "dock",
      group: "primary",
      order: 0,
    });
    expect(homeFromDropTarget(dockSecondary)).toEqual({
      kind: "dock",
      group: "secondary",
      order: 0,
    });
    expect(homeFromDropTarget(above.querySelector("button"))).toEqual({
      kind: "anchor",
      slot: "aboveComposer",
    });
    expect(homeFromDropTarget(below)).toEqual({ kind: "anchor", slot: "belowComposer" });
    expect(homeFromDropTarget(plain)).toBeNull();
    expect(homeFromDropTarget(null)).toBeNull();
  });
});
