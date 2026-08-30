import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { PiDeckExtensionUIDialogOptions } from "./pi-coding-agent-pideck.js";

function readPideck(options: ExtensionUIDialogOptions): PiDeckExtensionUIDialogOptions | undefined {
  return options.pideck;
}

async function callEditor(
  ui: Pick<ExtensionUIContext, "editor">,
  options: ExtensionUIDialogOptions,
): Promise<string | undefined> {
  return ui.editor("title", "", options);
}

function publishStructuredWidget(ui: Pick<ExtensionUIContext, "setWidget" | "onWidgetAction">) {
  const unsubscribe = ui.onWidgetAction("fleet", async (actionId) => {
    void actionId;
  });
  ui.setWidget("fleet", {
    pideck: 1,
    rows: [
      { kind: "text", text: "Ready", tone: "muted" },
      { kind: "actions", actions: [{ id: "open", label: "Open", style: "primary" }] },
    ],
  });
  return unsubscribe;
}

describe("PiDeck ExtensionUIDialogOptions augmentation", () => {
  it("types pideck on SDK dialog options and editor(opts)", async () => {
    const options: ExtensionUIDialogOptions = {
      timeout: 1,
      pideck: { presentation: "modal", sourceLabel: "Host" },
    };
    expect(readPideck(options)).toEqual({ presentation: "modal", sourceLabel: "Host" });
    await expect(callEditor({ editor: async () => "ok" }, options)).resolves.toBe("ok");
  });

  it("types structured widgets and their action handler", () => {
    const setWidget = vi.fn();
    const unsubscribe = vi.fn();
    const onWidgetAction = vi.fn(() => unsubscribe);
    expect(publishStructuredWidget({ setWidget, onWidgetAction })).toBe(unsubscribe);
    expect(setWidget).toHaveBeenCalledWith("fleet", expect.objectContaining({ pideck: 1 }));
  });
});
