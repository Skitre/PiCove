/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloatContentMessage, FloatIntent } from "../../lib/extension-float-channel";
import { closeContextMenu } from "../../lib/context-menu";

const transport = vi.hoisted(() => ({
  intents: [] as FloatIntent[],
  content: null as ((message: FloatContentMessage) => void) | null,
}));

vi.mock("../../lib/extension-float-transport", () => ({
  sendFloatIntent: (intent: FloatIntent) => {
    transport.intents.push(intent);
    return Promise.resolve();
  },
  subscribeFloatContent: (handler: (message: FloatContentMessage) => void) => {
    transport.content = handler;
    return Promise.resolve(() => {
      transport.content = null;
    });
  },
  subscribeFloatFrames: () => Promise.resolve(() => {}),
}));

// The terminal is exercised by the real-window smoke; here it would only pull
// xterm into jsdom for no assertion.
vi.mock("../dock/XtermSurface", () => ({
  XtermSurface: () => <div data-testid="float-xterm" />,
}));

const { FloatWindowRoot } = await import("./FloatWindowRoot");

const SLOT = "pi-subagents:widget";

function contentMessage(overrides: Partial<FloatContentMessage> = {}): FloatContentMessage {
  return {
    slotId: SLOT,
    family: "widget",
    chrome: {
      label: "pi-subagents Widget",
      language: "en",
      theme: "dark",
      themeFamily: "pideck",
      reducedMotion: false,
      pinned: false,
    },
    body: { kind: "widgets", widgets: [{ key: "fleet", widget: ["ready"] }] },
    ...overrides,
  };
}

async function publish(message: FloatContentMessage) {
  await act(async () => {
    transport.content?.(message);
  });
}

beforeEach(() => {
  transport.intents.length = 0;
  transport.content = null;
});

afterEach(() => {
  // The open menu is module state, not component state: unmounting the window
  // leaves it open and the next case would find its items.
  closeContextMenu();
  cleanup();
});

describe("FloatWindowRoot placement", () => {
  it("offers every destination except the one this window already is", async () => {
    render(<FloatWindowRoot slotId={SLOT} />);
    await publish(contentMessage());

    await userEvent.click(
      screen.getByRole("button", { name: "Change where pi-subagents Widget is shown" }),
    );

    // A float is this window. Offering it as a destination would mean "stay",
    // and the in-window layer it would otherwise name is a fallback, not a
    // place the user picks.
    expect(screen.queryByRole("menuitem", { name: "Its own window" })).toBeNull();
    for (const name of [
      "Follow Extension",
      "Above composer",
      "Below composer",
      "Extensions Dock · primary",
      "Extensions Dock · secondary",
      "Hidden",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("sends the choice rather than a resolved home, so the main window stays the only writer", async () => {
    render(<FloatWindowRoot slotId={SLOT} />);
    await publish(contentMessage());

    await userEvent.click(
      screen.getByRole("button", { name: "Change where pi-subagents Widget is shown" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Extensions Dock · primary" }));

    expect(transport.intents).toEqual([
      { kind: "setPlacement", slotId: SLOT, choice: "dockPrimary" },
    ]);
  });

  it("withholds Hidden from a custom panel, which must stay visible until it ends", async () => {
    render(<FloatWindowRoot slotId={SLOT} />);
    await publish(contentMessage({ family: "custom", body: { kind: "custom", requestId: "r1" } }));

    await userEvent.click(
      screen.getByRole("button", { name: "Change where pi-subagents Widget is shown" }),
    );
    expect(screen.queryByRole("menuitem", { name: "Hidden" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Follow Extension" })).toBeInTheDocument();
  });

  it("does nothing before any content has arrived, having no family to offer", async () => {
    render(<FloatWindowRoot slotId={SLOT} />);
    await userEvent.click(screen.getByRole("button", { name: `Change where ${SLOT} is shown` }));
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(transport.intents).toEqual([]);
  });

  it("ignores content addressed to another slot", async () => {
    render(<FloatWindowRoot slotId={SLOT} />);
    await publish(contentMessage({ slotId: "other:widget" }));
    expect(screen.getByText("Waiting for content…")).toBeInTheDocument();
  });
});
