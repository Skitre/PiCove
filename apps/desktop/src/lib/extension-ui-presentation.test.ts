import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENSION_UI_SETTINGS, type PresentationHome } from "@pideck/protocol";
import {
  isLegalPresentationChoice,
  presentationChoiceFromHome,
  presentationHomeFromChoice,
} from "./extension-ui-presentation";

const detached = {
  monitor: {
    name: "DELL U2419H",
    position: { x: 1512, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  },
  rect: { x: 1600, y: 120, width: 400, height: 300 },
};

const detachedFloat: PresentationHome = {
  kind: "float",
  rect: { x: 0.62, y: 0.08, width: 360, height: 240 },
  pinned: true,
  detached,
};

describe("presentationHomeFromChoice", () => {
  it("carries pin and detached placement through a re-pick of the same choice", () => {
    const next = presentationHomeFromChoice(
      "widget",
      "float",
      DEFAULT_EXTENSION_UI_SETTINGS,
      detachedFloat,
    );
    expect(next).toEqual(detachedFloat);
  });

  it("starts a fresh float attached when the previous home was not a float", () => {
    const next = presentationHomeFromChoice("widget", "float", DEFAULT_EXTENSION_UI_SETTINGS, {
      kind: "anchor",
      slot: "aboveComposer",
    });
    expect(next).toEqual({ kind: "float", rect: { x: 0.62, y: 0.08, width: 360, height: 240 } });
  });

  it("leaves the detached placement behind when the float moves to another home", () => {
    const docked = presentationHomeFromChoice(
      "widget",
      "dockPrimary",
      DEFAULT_EXTENSION_UI_SETTINGS,
      detachedFloat,
    );
    expect(docked).toEqual({ kind: "dock", group: "primary", order: 0 });
  });
});

describe("presentationChoiceFromHome", () => {
  it("reads a detached float as the float choice", () => {
    expect(presentationChoiceFromHome("widget", detachedFloat)).toBe("float");
    expect(isLegalPresentationChoice("widget", "float")).toBe(true);
  });

  it("still refuses float for a family that may not float", () => {
    expect(isLegalPresentationChoice("status", "float")).toBe(false);
  });
});
