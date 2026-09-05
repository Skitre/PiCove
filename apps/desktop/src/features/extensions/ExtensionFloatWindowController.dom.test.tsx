/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_UI_SETTINGS, type MonitorDescriptor } from "@pideck/protocol";
import type { FloatIntent } from "../../lib/extension-float-channel";
import type { ExtensionPresentationSlot } from "../../lib/extension-ui-slots";
import { useAppStore } from "../../lib/stores/app-store";
import { clearExtensionUiUndo, getExtensionUiUndo } from "../../lib/extension-ui-profile";
import { ExtensionFloatWindowController } from "./ExtensionFloatWindowController";

const fixture = vi.hoisted(() => ({
  slots: [] as ExtensionPresentationSlot[],
  onIntent: null as ((intent: FloatIntent) => void) | null,
  dispatch: vi.fn(async () => null),
  monitors: [] as MonitorDescriptor[],
}));

vi.mock("../../lib/extension-widget-action", () => ({
  dispatchExtensionWidgetAction: fixture.dispatch,
}));
vi.mock("../../lib/extension-ui-live-slots", () => ({
  useLiveExtensionPresentationSlots: () => fixture.slots,
}));
vi.mock("../dock/ExtensionTerminal", () => ({
  closeExtensionTerminalWithFallback: async () => null,
}));
vi.mock("../../lib/extension-float-transport", () => ({
  listFloatMonitors: async () => fixture.monitors,
  openFloatWindow: async () => null,
  closeFloatWindow: async () => {},
  setFloatWindowBounds: async () => {},
  setFloatWindowAlwaysOnTop: async () => {},
  publishFloatContent: async () => {},
  publishFloatFrame: async () => {},
  subscribeFloatIntents: async (handler: typeof fixture.onIntent) => {
    fixture.onIntent = handler;
    return () => {
      fixture.onIntent = null;
    };
  },
}));

function slot(extensionId?: string): ExtensionPresentationSlot {
  return {
    slotId: `${extensionId ?? "unknown"}:widget`,
    extensionId,
    family: "widget",
    source: "profile",
    mounts: [
      {
        home: { kind: "float", rect: { x: 0.1, y: 0.1, width: 360, height: 240 } },
        widgets: [
          {
            key: "summary",
            widget: {
              pideck: 1,
              rows: [
                {
                  kind: "actions",
                  actions: [
                    { id: "open", label: "Open" },
                    { id: "disabled", label: "Disabled", disabled: true },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  clearExtensionUiUndo();
  fixture.monitors = [];
  fixture.slots = [slot("ext_a"), slot("ext_b"), slot()];
  fixture.dispatch.mockClear();
  useAppStore.setState({
    desktopSettings: null,
    surfaceLanguage: "en",
    collapsedExtensionWidgetKeys: {},
  });
});
afterEach(cleanup);

it("remembers native moves and resizes without offering Undo, while placement changes still do", async () => {
  const monitor: MonitorDescriptor = {
    name: "Display",
    position: { x: 0, y: 0 },
    size: { width: 1512, height: 982 },
    scaleFactor: 2,
  };
  fixture.monitors = [monitor];
  const entry = slot("ext_a");
  const home = {
    kind: "float" as const,
    rect: { x: 0.1, y: 0.1, width: 360, height: 240 },
    detached: { rect: { x: 100, y: 100, width: 360, height: 240 }, monitor },
  };
  entry.mounts[0]!.home = home;
  fixture.slots = [entry];
  useAppStore.getState().setDesktopSettings({
    theme: "dark",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
    extensionUi: {
      ...DEFAULT_EXTENSION_UI_SETTINGS,
      presentations: { ext_a: { widget: { home } } },
    },
  });
  render(<ExtensionFloatWindowController />);
  await waitFor(() => expect(fixture.onIntent).not.toBeNull());

  for (const rect of [
    { x: 200, y: 180, width: 360, height: 240 },
    { x: 200, y: 180, width: 480, height: 320 },
  ]) {
    await act(async () => {
      fixture.onIntent?.({ kind: "geometry", slotId: entry.slotId, rect });
    });
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionUi?.presentations.ext_a?.widget,
      ).toMatchObject({ home: { detached: { rect } } }),
    );
    expect(getExtensionUiUndo()).toBeNull();
  }

  await act(async () => {
    fixture.onIntent?.({ kind: "setPlacement", slotId: entry.slotId, choice: "dockPrimary" });
  });
  await waitFor(() => expect(getExtensionUiUndo()).not.toBeNull());
  clearExtensionUiUndo();
});

it("derives the publisher from the main-owned slot even if the Float supplies another identity", async () => {
  render(<ExtensionFloatWindowController />);
  await waitFor(() => expect(fixture.onIntent).not.toBeNull());
  await act(async () => {
    fixture.onIntent?.({
      kind: "widgetAction",
      slotId: "ext_a:widget",
      key: "summary",
      actionId: "open",
      extensionId: "ext_b",
    } as FloatIntent);
    fixture.onIntent?.({
      kind: "widgetAction",
      slotId: "ext_b:widget",
      key: "summary",
      actionId: "open",
    });
  });
  expect(fixture.dispatch.mock.calls).toEqual([
    ["ext_a", "summary", "open"],
    ["ext_b", "summary", "open"],
  ]);
});

it("rejects unowned slots and missing or disabled actions before dispatch", async () => {
  render(<ExtensionFloatWindowController />);
  await waitFor(() => expect(fixture.onIntent).not.toBeNull());
  await act(async () => {
    for (const [slotId, key, actionId] of [
      ["unknown:widget", "summary", "open"],
      ["missing:widget", "summary", "open"],
      ["ext_a:widget", "missing", "open"],
      ["ext_a:widget", "summary", "missing"],
      ["ext_a:widget", "summary", "disabled"],
    ])
      fixture.onIntent?.({ kind: "widgetAction", slotId: slotId!, key: key!, actionId: actionId! });
  });
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
