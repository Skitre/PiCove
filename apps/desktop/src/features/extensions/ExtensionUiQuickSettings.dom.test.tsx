/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTENSION_UI_SETTINGS,
  MAX_EXTENSION_UI_FLOATS,
  type DesktopSettings,
  type PresentationHome,
} from "@pideck/protocol";
import { ChatHeader } from "../chat/ChatHeader";
import { ExtensionUiSettingsSection } from "../settings/ExtensionUiSettingsSection";
import { extensionQuickPanelPosition } from "./ExtensionUiQuickSettings";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { resetNativeExtensionUiCompatForTests } from "../../lib/desktop-settings";
import { resetObservedExtensionDisplayNames } from "../../lib/extension-ui-observation";
import { liveExtensionPresentationSlots } from "../../lib/extension-ui-live-slots";
import {
  clearExtensionUiUndo,
  getExtensionUiUndo,
  undoExtensionUiSettings,
} from "../../lib/extension-ui-profile";
import { isBrowserOccluded, resetBrowserOcclusionForTests } from "../../lib/browser-occlusion";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/core", () => native);

const baseSettings: DesktopSettings = {
  theme: "system",
  language: "en",
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto",
  terminalProfile: "auto",
  extensionUi: {
    ...DEFAULT_EXTENSION_UI_SETTINGS,
    presentations: { live: { status: { home: { kind: "hidden" } } } },
    observedCapabilities: {
      review: {
        displayName: "Review",
        families: ["widget", "custom", "blockingDialog"],
        lastSeenAt: 30,
      },
      dialogs: { displayName: "Dialogs only", families: ["blockingDialog"], lastSeenAt: 40 },
      live: { displayName: "Live status", families: ["status"], lastSeenAt: 1 },
      other: { displayName: "Other", families: ["widget"], lastSeenAt: 30 },
    },
  },
};

function origin(extensionId: string) {
  return {
    invocationKind: "command" as const,
    extensionId,
    extensionDisplayName: extensionId,
    sourceKind: "package" as const,
    commandName: "inspect",
  };
}

function setHome(extensionId: string, home: PresentationHome) {
  const settings = useAppStore.getState().desktopSettings!;
  useAppStore.getState().setDesktopSettings({
    ...settings,
    extensionUi: {
      ...settings.extensionUi!,
      presentations: {
        ...settings.extensionUi!.presentations,
        [extensionId]: { widget: { home } },
      },
    },
  });
}

function fillFloatCapacity() {
  for (let index = 0; index < MAX_EXTENSION_UI_FLOATS; index++) {
    const id = "floating-" + index;
    setHome(id, { kind: "float", rect: { x: 0.2, y: 0.2, width: 300, height: 180 } });
    useAppStore.getState().setExtensionWidget({
      key: id,
      widget: ["running"],
      origin: origin(id),
      hostInstanceId: "host",
      workspaceId: "workspace",
      workspaceRevision: 1,
      sessionId: "session",
      sessionRevision: 1,
    });
  }
}

async function openPanel() {
  const user = userEvent.setup();
  render(
    <>
      <ChatHeader />
      <button type="button">Outside</button>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Extension UI quick settings" });
  await user.click(trigger);
  return { user, trigger, panel: screen.getByRole("dialog", { name: "Extension UI" }) };
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(false);
  resetNativeExtensionUiCompatForTests();
  resetBrowserOcclusionForTests();
  resetObservedExtensionDisplayNames();
  clearExtensionUiUndo();
  useAppStore.setState({
    page: "chat",
    settingsSection: null,
    host: null,
    session: null,
    dockOpen: false,
    extensionWidgets: {},
    extensionStatuses: {},
    extensionStatusOrigins: {},
    extensionTerminal: null,
    notifications: [],
  });
  useAppStore.getState().setDesktopSettings(baseSettings);
  useAppStore.getState().setExtensionStatus("live-status", "ready", origin("live"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearExtensionUiUndo();
  resetBrowserOcclusionForTests();
  resetObservedExtensionDisplayNames();
});

describe("Extension UI quick settings", () => {
  it("keeps the entry immediately before the Dock toggle without an active session", async () => {
    const { trigger, user } = await openPanel();
    expect(trigger.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Open right panel" }),
    );
    expect(trigger.closest("[data-chat-header]")).toHaveClass("pr-[140px]");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => useAppStore.getState().setDockOpen(true));
    expect(trigger.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Collapse right panel" }),
    );
    expect(trigger.closest("[data-chat-header]")).toHaveClass("pr-2");
  });

  it("focuses search, dismisses with Escape or outside clicks, and releases browser occlusion", async () => {
    const { user, trigger } = await openPanel();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(isBrowserOccluded()).toBe(true);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(isBrowserOccluded()).toBe(false);
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(trigger);
    screen.getByRole("button", { name: "Full settings" }).focus();
    await user.tab();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(isBrowserOccluded()).toBe(false);
  });

  it("lists eligible recorded extensions with hidden live content first and searches names and IDs", async () => {
    const { user, panel } = await openPanel();
    expect(
      within(panel)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Live status", "Other", "Review"]);
    expect(within(panel).queryByText("Dialogs only")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Blocking requests")).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox");
    await user.type(search, " REVIEW ");
    expect(within(panel).getAllByRole("heading", { level: 3 })).toHaveLength(1);
    expect(within(panel).getAllByRole("combobox")).toHaveLength(2);
    await user.clear(search);
    await user.type(search, "no match");
    expect(within(panel).getByRole("status")).toHaveTextContent("No matching extensions.");
    await user.clear(search);
    await user.type(search, "live");
    expect(within(panel).getByRole("combobox")).toHaveValue("hidden");
  });

  it("keeps blank panel clicks open, including WebKit blur with no related target", async () => {
    const { user, panel, trigger } = await openPanel();
    await user.click(within(panel).getByRole("heading", { name: "Extension UI" }));
    expect(panel).toBeInTheDocument();
    await user.click(screen.getByRole("searchbox"));
    fireEvent.pointerDown(panel);
    fireEvent.blur(screen.getByRole("searchbox"), { relatedTarget: null });
    expect(panel).toHaveFocus();
    fireEvent.pointerUp(panel);
    expect(isBrowserOccluded()).toBe(true);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the existing legal choices and immediately shares saved values and Undo with full settings", async () => {
    const request = vi.spyOn(hostClient, "request");
    const { user, panel } = await openPanel();
    const status = screen.getByRole("combobox", {
      name: "Change where Live status Status is shown",
    });
    expect(Array.from(status.querySelectorAll("option")).map((option) => option.value)).toEqual([
      "aboveComposer",
      "dockPrimary",
      "dockSecondary",
      "hidden",
    ]);
    await user.selectOptions(status, "aboveComposer");
    await waitFor(() => expect(status).toHaveValue("aboveComposer"));
    expect(
      liveExtensionPresentationSlots().find((slot) => slot.extensionId === "live")?.mounts[0].home,
    ).toEqual({
      kind: "anchor",
      slot: "aboveComposer",
    });
    expect(getExtensionUiUndo()).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      await undoExtensionUiSettings();
    });
    expect(status).toHaveValue("hidden");
    expect(within(panel).getByRole("heading", { name: "Live status" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Full settings" }));
    expect(useAppStore.getState()).toMatchObject({
      page: "settings",
      settingsSection: "extensionUi",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(isBrowserOccluded()).toBe(false);
    render(<ExtensionUiSettingsSection />);
    expect(screen.getByRole("combobox", { name: "Status Show in" })).toHaveValue("hidden");
  });

  it("preserves float geometry and detached placement when changing pinning", async () => {
    const home: PresentationHome = {
      kind: "float",
      rect: { x: 0.3, y: 0.2, width: 360, height: 240 },
      detached: {
        monitor: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 },
        rect: { x: 500, y: 100, width: 360, height: 240 },
      },
    };
    setHome("review", home);
    const { user } = await openPanel();
    await user.click(screen.getByRole("switch", { name: "Pin Review Widget" }));
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations.review.widget?.home,
      ).toEqual({
        ...home,
        pinned: true,
      }),
    );
  });

  it("disables new floats at capacity and rechecks the limit even for a stale selection event", async () => {
    const { panel } = await openPanel();
    const select = within(panel).getByRole("combobox", {
      name: "Change where Review Widget is shown",
    });
    act(fillFloatCapacity);
    expect(within(select).getByRole("option", { name: "Its own window" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "float" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "limit of " + MAX_EXTENSION_UI_FLOATS,
    );
    expect(
      useAppStore.getState().desktopSettings?.extensionUi?.presentations.review,
    ).toBeUndefined();
  });

  it("keeps the old value and reports a native save failure", async () => {
    native.isTauri.mockReturnValue(true);
    native.invoke.mockRejectedValue(new Error("disk full"));
    const { user } = await openPanel();
    const select = screen.getByRole("combobox", { name: "Change where Review Widget is shown" });
    await user.selectOptions(select, "hidden");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your previous setting is still active.",
    );
    expect(select).toHaveValue("followExtension");
    expect(select).toBeEnabled();
    expect(getExtensionUiUndo()).toBeNull();
    expect(useAppStore.getState().notifications.at(-1)?.message).toContain("disk full");
  });

  it("finishes an in-flight save after closing and disables edits when reopened", async () => {
    native.isTauri.mockReturnValue(true);
    let finish!: () => void;
    native.invoke.mockImplementation(
      (_command, { patch }) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...baseSettings, ...patch });
        }),
    );
    const { user, trigger } = await openPanel();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Change where Review Widget is shown" }),
      "hidden",
    );
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    expect(
      screen.getAllByRole("combobox").every((select) => (select as HTMLSelectElement).disabled),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(trigger);
    const select = screen.getByRole("combobox", { name: "Change where Review Widget is shown" });
    expect(select).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("hidden");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("shows the localized empty state when no non-blocking families have been recorded", async () => {
    useAppStore.getState().setDesktopSettings({
      ...baseSettings,
      language: "zh",
      extensionUi: {
        ...DEFAULT_EXTENSION_UI_SETTINGS,
        observedCapabilities: { dialogs: baseSettings.extensionUi!.observedCapabilities.dialogs },
      },
    });
    const user = userEvent.setup();
    render(<ChatHeader />);
    await user.click(screen.getByRole("button", { name: "Extension UI 快捷设置" }));
    expect(screen.getByRole("status")).toHaveTextContent("暂无可调整的扩展界面。");
    expect(screen.getByRole("button", { name: "完整设置" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("clamps to narrow viewports and follows a moving toolbar anchor", async () => {
    expect(extensionQuickPanelPosition({ right: 1000, bottom: 44 }, 1280, 800)).toEqual({
      left: 660,
      top: 50,
      width: 340,
      maxHeight: 560,
    });
    expect(extensionQuickPanelPosition({ right: 350, bottom: 44 }, 360, 400)).toEqual({
      left: 12,
      top: 50,
      width: 336,
      maxHeight: 338,
    });
    const { trigger, panel } = await openPanel();
    let rect = { right: 1000, bottom: 44 } as DOMRect;
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => rect);
    await waitFor(() => expect(panel).toHaveStyle({ left: "660px" }));
    rect = { ...rect, right: 800 };
    await waitFor(() => expect(panel).toHaveStyle({ left: "460px" }));
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 400);
    await waitFor(() =>
      expect(panel).toHaveStyle({ left: "12px", width: "336px", maxHeight: "338px" }),
    );
  });

  it("resizes from the bottom left, respects bounds, and retains the size when reopened", async () => {
    const { user, trigger, panel } = await openPanel();
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      right: 1000,
      bottom: 44,
    } as DOMRect);
    await waitFor(() => expect(panel).toHaveStyle({ width: "340px", left: "660px" }));
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: Number.parseFloat(panel.style.left),
          top: Number.parseFloat(panel.style.top),
          right: Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width),
          bottom:
            Number.parseFloat(panel.style.top) + (Number.parseFloat(panel.style.height) || 400),
          width: Number.parseFloat(panel.style.width),
          height: Number.parseFloat(panel.style.height) || 400,
        }) as DOMRect,
    );
    const handle = panel.querySelector<HTMLElement>('[data-extension-ui-quick-resize="sw"]')!;
    const capture = vi.fn();
    const release = vi.fn();
    handle.setPointerCapture = capture;
    handle.releasePointerCapture = release;

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 680, clientY: 430 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 620, clientY: 480 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(panel).toHaveStyle({ width: "400px", height: "450px", left: "600px", top: "50px" });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -1000, clientY: 2000 });
    expect(panel).toHaveStyle({ width: "988px", height: "738px", left: "12px" });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000, clientY: -1000 });
    expect(panel).toHaveStyle({ width: "280px", height: "240px", left: "720px" });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 620, clientY: 480 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(release).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 600 });
    expect(panel).toHaveStyle({ width: "400px", height: "450px" });

    await user.keyboard("{Escape}");
    await user.click(trigger);
    const reopened = screen.getByRole("dialog", { name: "Extension UI" });
    expect(reopened).toHaveStyle({ width: "400px", height: "450px" });
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 400);
    await waitFor(() =>
      expect(reopened).toHaveStyle({ width: "336px", height: "338px", left: "12px" }),
    );
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 800);
    await waitFor(() =>
      expect(reopened).toHaveStyle({ width: "400px", height: "450px", left: "600px" }),
    );
    expect(native.invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().desktopSettings).toEqual(baseSettings);
  });

  it.each(["n", "s", "w", "e", "nw", "ne", "sw", "se"])(
    "resizes the %s border while keeping the opposite border fixed",
    async (edge) => {
      const { user, trigger, panel } = await openPanel();
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        right: 1000,
        bottom: 44,
      } as DOMRect);
      await waitFor(() => expect(panel).toHaveStyle({ width: "340px" }));
      vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            left: Number.parseFloat(panel.style.left),
            top: Number.parseFloat(panel.style.top),
            right: Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width),
            bottom:
              Number.parseFloat(panel.style.top) + (Number.parseFloat(panel.style.height) || 400),
            width: Number.parseFloat(panel.style.width),
            height: Number.parseFloat(panel.style.height) || 400,
          }) as DOMRect,
      );
      expect(
        screen.queryByRole("button", { name: "Resize Extension UI panel" }),
      ).not.toBeInTheDocument();
      const handle = panel.querySelector<HTMLElement>(
        '[data-extension-ui-quick-resize="' + edge + '"]',
      )!;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 680, clientY: 430 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 660, clientY: 450 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(panel).toHaveStyle({
        left: (edge.includes("w") ? 640 : 660) + "px",
        top: (edge.includes("n") ? 70 : 50) + "px",
        width: (edge.includes("w") ? 360 : edge.includes("e") ? 320 : 340) + "px",
        height: (edge.includes("n") ? 380 : edge.includes("s") ? 420 : 400) + "px",
      });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.doubleClick(handle);
      expect(panel).toHaveStyle({ width: "340px", maxHeight: "560px" });
      expect(panel.style.height).toBe("");
      await user.keyboard("{Escape}");
      expect(trigger).toHaveFocus();
      expect(isBrowserOccluded()).toBe(false);
    },
  );
});
