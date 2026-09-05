/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FloatIntent } from "../../lib/extension-float-channel";
import type { ExtensionPresentationSlot } from "../../lib/extension-ui-slots";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionFloatWindowController } from "./ExtensionFloatWindowController";

const fixture = vi.hoisted(() => ({
  slots: [] as ExtensionPresentationSlot[],
  onIntent: null as ((intent: FloatIntent) => void) | null,
  dispatch: vi.fn(async () => null),
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
  listFloatMonitors: async () => [],
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
  fixture.slots = [slot("ext_a"), slot("ext_b"), slot()];
  fixture.dispatch.mockClear();
  useAppStore.setState({
    desktopSettings: null,
    surfaceLanguage: "en",
    collapsedExtensionWidgetKeys: {},
  });
});
afterEach(cleanup);

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
