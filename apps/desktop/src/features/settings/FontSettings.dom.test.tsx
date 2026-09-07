/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopFontCatalog } from "@pideck/protocol";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  prepare: vi.fn(),
  persist: vi.fn(),
  remove: vi.fn(),
  importFonts: vi.fn(),
  open: vi.fn(),
  drop: null as
    | null
    | ((event: {
        payload: { type: string; position: { x: number; y: number }; paths?: string[] };
      }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.drop) => {
      mocks.drop = handler;
      return () => {
        mocks.drop = null;
      };
    },
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../lib/fonts", async (original) => ({
  ...(await original<typeof import("../../lib/fonts")>()),
  listFontCatalog: mocks.list,
  prepareFont: mocks.prepare,
  importFonts: mocks.importFonts,
}));
vi.mock("../../lib/desktop-settings", () => ({
  persistDesktopSettings: mocks.persist,
  removeImportedFont: mocks.remove,
  notifyDesktopSettingsSaveFailure: vi.fn(),
}));
import { FontSettings, dropHitsFontArea } from "./FontSettings";
import { useAppStore } from "../../lib/stores/app-store";

const id = "a".repeat(64);
const catalog: DesktopFontCatalog = {
  families: [
    { id: "sans", family: "Example Sans", source: "system", monospace: false, faces: [] },
    { id: "mono", family: "Example Mono", source: "system", monospace: true, faces: [] },
    {
      id,
      family: "Private Font",
      source: "imported",
      monospace: false,
      faces: [{ id: "b".repeat(64), weight: "400", style: "normal", stretch: "100%" }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 252,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 400,
  });
  mocks.list.mockResolvedValue(catalog);
  mocks.prepare.mockResolvedValue('"Preview Family"');
  mocks.persist.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.importFonts.mockResolvedValue({
    items: [
      { name: "demo.ttf", status: "imported", detail: "Private Font" },
      { name: "bad.ttf", status: "failed", detail: "Invalid font" },
    ],
  });
  useAppStore.getState().setDesktopSettings({
    theme: "dark",
    language: "en",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPicker(name = "Interface font") {
  const user = userEvent.setup();
  render(<FontSettings />);
  const trigger = await screen.findByRole("button", { name });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  return user;
}

describe("font management", () => {
  it("searches many system fonts, previews with arrows, and persists only on confirmation", async () => {
    mocks.list.mockResolvedValue({
      families: [
        ...catalog.families,
        ...Array.from({ length: 1000 }, (_, index) => ({
          id: "extra-" + index,
          family: "Extra " + index,
          source: "system",
          monospace: false,
          faces: [],
        })),
      ],
    });
    const user = await openPicker();
    expect(screen.getAllByRole("option").length).toBeLessThan(20);
    const input = screen.getByRole("combobox", { name: "Search font families" });
    await user.type(input, "Example Mono");
    expect(screen.queryByRole("option", { name: "Example Sans" })).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(mocks.prepare).toHaveBeenLastCalledWith({ source: "system", family: "Example Mono" }),
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Use font" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Use font" }));
    expect(mocks.persist).toHaveBeenCalledWith({
      uiFont: { source: "system", family: "Example Mono" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("filters monospace fonts and cancels without changing the saved category", async () => {
    const user = await openPicker("Code font");
    await user.click(screen.getByRole("checkbox", { name: "Show only monospace fonts" }));
    expect(screen.queryByRole("option", { name: "Example Sans" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("keeps the picker and saved choice after a write failure", async () => {
    mocks.persist.mockRejectedValue(new Error("disk full"));
    const user = await openPicker();
    await user.click(screen.getByRole("option", { name: "Example Sans" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use font" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Use font" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useAppStore.getState().desktopSettings?.uiFont).toBeUndefined();
  });

  it("retries a failed preview before enabling confirmation", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Font load failed"));
    const user = await openPicker();
    expect(await screen.findByRole("alert")).toHaveTextContent("Font load failed");
    expect(screen.getByRole("button", { name: "Use font" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use font" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("imports a file batch and reports partial failure", async () => {
    mocks.open.mockResolvedValue(["/fonts/demo.ttf", "/fonts/bad.ttf"]);
    const user = userEvent.setup();
    render(<FontSettings />);
    await user.click(screen.getByRole("button", { name: "Choose font files" }));
    expect(await screen.findByText("1 imported · 0 skipped · 1 failed")).toBeInTheDocument();
    expect(mocks.importFonts).toHaveBeenCalledWith(["/fonts/demo.ttf", "/fonts/bad.ttf"]);
  });

  it("deletes an imported family only after reviewing the affected-category behavior", async () => {
    const user = userEvent.setup();
    render(<FontSettings />);
    await user.click(await screen.findByRole("button", { name: "Delete Private Font" }));
    expect(within(screen.getByRole("dialog")).getByText(/Categories using it/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete font" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(id));
  });

  it("accepts native drops only inside the import area, including scaled displays", async () => {
    render(<FontSettings />);
    await waitFor(() => expect(mocks.drop).not.toBeNull());
    const area = screen.getByText("Drop font files or a ZIP here").closest(".border-dashed")!;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 100,
      top: 20,
      bottom: 80,
    } as DOMRect);
    await act(async () => {
      mocks.drop?.({
        payload: { type: "drop", position: { x: 500, y: 500 }, paths: ["/bad.ttf"] },
      });
    });
    expect(mocks.importFonts).not.toHaveBeenCalled();
    await act(async () => {
      mocks.drop?.({ payload: { type: "drop", position: { x: 50, y: 40 }, paths: ["/good.ttf"] } });
    });
    expect(mocks.importFonts).toHaveBeenCalledWith(["/good.ttf"]);
    expect(
      dropHitsFontArea({ x: 100, y: 80 }, 2, { left: 10, right: 100, top: 20, bottom: 80 }),
    ).toBe(true);
  });
});
