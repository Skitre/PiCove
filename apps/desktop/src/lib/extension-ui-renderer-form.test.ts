import { describe, expect, it } from "vitest";
import { rendererFormFor } from "./extension-ui-renderer-form";

describe("rendererFormFor", () => {
  it("keeps widgets compact on anchors and paneled in dock/float", () => {
    expect(rendererFormFor("widget", "anchor")).toBe("strip");
    expect(rendererFormFor("widget", "dock")).toBe("panel");
    expect(rendererFormFor("widget", "float")).toBe("panel");
    expect(rendererFormFor("widget", "hidden")).toBe("panel");
  });

  it("keeps status compact on anchors and listed in dock", () => {
    expect(rendererFormFor("status", "anchor")).toBe("strip");
    expect(rendererFormFor("status", "dock")).toBe("list");
    expect(rendererFormFor("status", "float")).toBe("list");
    expect(rendererFormFor("status", "hidden")).toBe("list");
  });
});
