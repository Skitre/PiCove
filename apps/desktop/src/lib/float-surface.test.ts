import { describe, expect, it } from "vitest";
import { surfaceRouteFromSearch } from "./float-surface";

describe("surfaceRouteFromSearch", () => {
  it("boots the application shell for a normal document", () => {
    expect(surfaceRouteFromSearch("")).toEqual({ kind: "app" });
    expect(surfaceRouteFromSearch("?pideck-reload=1699999999")).toEqual({ kind: "app" });
  });

  it("boots one slot for a float window", () => {
    expect(surfaceRouteFromSearch("?surface=float&slot=pi-subagents%3Awidget")).toEqual({
      kind: "float",
      slotId: "pi-subagents:widget",
    });
  });

  it("ignores unrelated parameters alongside the slot", () => {
    expect(
      surfaceRouteFromSearch("?pideck-reload=7&surface=float&slot=ext%3Acustom&other=x"),
    ).toEqual({ kind: "float", slotId: "ext:custom" });
  });

  it("falls back to the shell rather than opening a float with no usable slot", () => {
    expect(surfaceRouteFromSearch("?surface=float")).toEqual({ kind: "app" });
    expect(surfaceRouteFromSearch("?surface=float&slot=")).toEqual({ kind: "app" });
    expect(surfaceRouteFromSearch(`?surface=float&slot=${"x".repeat(513)}`)).toEqual({
      kind: "app",
    });
  });

  it("rejects control characters smuggled through the query string", () => {
    for (const code of [0x00, 0x0a, 0x1f, 0x7f, 0x9f]) {
      const encoded = encodeURIComponent(`ext${String.fromCharCode(code)}:widget`);
      expect(surfaceRouteFromSearch(`?surface=float&slot=${encoded}`)).toEqual({ kind: "app" });
    }
  });

  it("keeps a slot id whose characters are merely unusual", () => {
    const slotId = "@scope/pkg 名前:widget";
    expect(surfaceRouteFromSearch(`?surface=float&slot=${encodeURIComponent(slotId)}`)).toEqual({
      kind: "float",
      slotId,
    });
  });

  it("treats an unknown surface as the application shell", () => {
    expect(surfaceRouteFromSearch("?surface=inspector&slot=ext%3Awidget")).toEqual({ kind: "app" });
  });
});
