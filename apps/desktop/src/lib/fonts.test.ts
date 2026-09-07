/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { DesktopFontCatalog } from "@pideck/protocol";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => native);
import {
  applyFontPreferences,
  fontCssFamily,
  fontLoadError,
  invalidateFontLibrary,
  isFontReference,
  listFontCatalog,
  prepareFont,
} from "./fonts";

const id = "a".repeat(64);
const faceId = "b".repeat(64);
const catalog: DesktopFontCatalog = {
  families: [
    { id: "system", family: "Example Sans", source: "system", monospace: false, faces: [] },
    {
      id,
      family: "Imported Mono",
      source: "imported",
      monospace: true,
      faces: [{ id: faceId, weight: "100 900", style: "normal", stretch: "100%" }],
    },
  ],
};

class TestFontFace {
  status = "unloaded";
  constructor(
    public family: string,
    public data: ArrayBuffer,
    public descriptors: FontFaceDescriptors,
  ) {}
  async load() {
    this.status = "loaded";
    return this;
  }
}

beforeEach(() => {
  native.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "desktop_fonts_list") return catalog;
    if (command === "desktop_font_read") return new Uint8Array([0, 1, 2]).buffer;
    throw new Error(command);
  });
  vi.stubGlobal("FontFace", TestFontFace);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn(), load: vi.fn().mockResolvedValue([]) },
  });
  applyFontPreferences({});
  invalidateFontLibrary();
});
afterEach(() => {
  applyFontPreferences({});
  vi.unstubAllGlobals();
});

describe("font references and runtime", () => {
  it("accepts only typed references and quotes a single CSS family", () => {
    expect(isFontReference({ source: "system", family: 'A "B"\\C' })).toBe(true);
    expect(fontCssFamily({ source: "system", family: 'A "B"\\C' })).toBe('"A \\"B\\"\\\\C"');
    for (const bad of [
      { source: "imported", id: "../file.ttf" },
      { source: "system", family: "\nArial" },
      { source: "default", family: "Arial" },
      { source: "system", family: " " },
    ])
      expect(isFontReference(bad)).toBe(false);
  });

  it("loads imported bytes by face ID and preserves variable font descriptors", async () => {
    await prepareFont({ source: "imported", id });
    expect(native.invoke).toHaveBeenCalledWith("desktop_font_read", { id: faceId });
    expect(document.fonts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "PiDeck Imported " + id,
        descriptors: expect.objectContaining({ weight: "100 900" }),
      }),
    );
    await prepareFont({ source: "imported", id });
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "desktop_font_read"),
    ).toHaveLength(1);
  });

  it("keeps categories independent, theme fallbacks intact, and resets synchronously", async () => {
    applyFontPreferences({
      uiFont: { source: "system", family: "Example Sans" },
      codeFont: { source: "imported", id },
    });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--font-mono")).toContain(
        "PiDeck Imported",
      ),
    );
    expect(document.documentElement.style.getPropertyValue("--font-text")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
      '"Example Sans", var(--font-default-sans)',
    );
    applyFontPreferences({});
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("");
  });

  it("falls back without rewriting a missing selection, and retries after refresh", async () => {
    const reference = { source: "system" as const, family: "Missing" };
    applyFontPreferences({ textFont: reference });
    await waitFor(() => expect(fontLoadError(reference)).toContain("unavailable"));
    expect(document.documentElement.style.getPropertyValue("--font-text")).toBe("");
    native.invoke.mockResolvedValue({ families: [{ ...catalog.families[0], family: "Missing" }] });
    await listFontCatalog(true, true);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--font-text")).toContain('"Missing"'),
    );
    expect(fontLoadError(reference)).toBeUndefined();
  });

  it("ignores a stale asynchronous selection after returning to default", async () => {
    let resolve!: (value: DesktopFontCatalog) => void;
    native.invoke.mockReturnValue(
      new Promise<DesktopFontCatalog>((done) => {
        resolve = done;
      }),
    );
    applyFontPreferences({ uiFont: { source: "system", family: "Example Sans" } });
    applyFontPreferences({});
    resolve(catalog);
    await new Promise((done) => setTimeout(done, 0));
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("");
  });

  it("lets thin-client floats apply the main window's system choice without enumerating fonts", async () => {
    applyFontPreferences({ codeFont: { source: "system", family: "Approved Mono" } }, false);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--font-mono")).toContain(
        "Approved Mono",
      ),
    );
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
