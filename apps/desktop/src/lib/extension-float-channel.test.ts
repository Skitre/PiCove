import { describe, expect, it } from "vitest";
import {
  appendFrameTail,
  MAX_FLOAT_FRAME_TAIL_BYTES,
  floatContentBody,
  floatContentChanged,
  floatContentMessage,
  isIntentForSlot,
  type FloatChrome,
} from "./extension-float-channel";
import type { ExtensionPresentationSlot, PresentationSlotMount } from "./extension-ui-slots";

const chrome: FloatChrome = {
  label: "Review widget",
  language: "en",
  theme: "dark",
  themeFamily: "pideck",
  reducedMotion: false,
  pinned: false,
};

const slot: ExtensionPresentationSlot = {
  slotId: "pi-subagents:widget",
  extensionId: "pi-subagents",
  family: "widget",
  source: "profile",
  mounts: [],
};

const floatHome = {
  kind: "float" as const,
  rect: { x: 0.6, y: 0.1, width: 360, height: 240 },
};

function mount(partial: Partial<PresentationSlotMount>): PresentationSlotMount {
  return { home: floatHome, ...partial };
}

describe("floatContentBody", () => {
  it("carries widget rows", () => {
    const widgets = [{ key: "fleet", widget: ["a", "b"] }];
    expect(floatContentBody(mount({ widgets }))).toEqual({ kind: "widgets", widgets });
  });

  it("carries status rows", () => {
    const statuses = [{ key: "state", text: "running" }];
    expect(floatContentBody(mount({ statuses }))).toEqual({ kind: "statuses", statuses });
  });

  it("carries only the request id for a custom panel, never its frames", () => {
    expect(floatContentBody(mount({ custom: { requestId: "req-1" } }))).toEqual({
      kind: "custom",
      requestId: "req-1",
    });
  });

  it("reports an empty mount rather than inventing content", () => {
    expect(floatContentBody(mount({}))).toEqual({ kind: "empty" });
    expect(floatContentBody(mount({ widgets: [] }))).toEqual({ kind: "empty" });
  });

  it("copies the rows so a later store mutation cannot reach a sent message", () => {
    const widgets = [{ key: "fleet", widget: ["a"] }];
    const body = floatContentBody(mount({ widgets }));
    widgets.push({ key: "second", widget: ["b"] });
    expect(body.kind === "widgets" && body.widgets).toHaveLength(1);
  });
});

describe("floatContentChanged", () => {
  const base = floatContentMessage({
    slot,
    mount: mount({ widgets: [{ key: "fleet", widget: ["a"] }] }),
    chrome,
  });

  it("sends the first message", () => {
    expect(floatContentChanged(undefined, base)).toBe(true);
  });

  it("skips an identical re-render, so store churn does not flood the channel", () => {
    const same = floatContentMessage({
      slot,
      mount: mount({ widgets: [{ key: "fleet", widget: ["a"] }] }),
      chrome,
    });
    expect(floatContentChanged(base, same)).toBe(false);
  });

  it("sends when the content changes", () => {
    const next = floatContentMessage({
      slot,
      mount: mount({ widgets: [{ key: "fleet", widget: ["b"] }] }),
      chrome,
    });
    expect(floatContentChanged(base, next)).toBe(true);
  });

  it("sends when only the chrome changes, so theme and pin still reach the window", () => {
    const next = floatContentMessage({
      slot,
      mount: mount({ widgets: [{ key: "fleet", widget: ["a"] }] }),
      chrome: { ...chrome, theme: "light" },
    });
    expect(floatContentChanged(base, next)).toBe(true);
    const pinned = floatContentMessage({
      slot,
      mount: mount({ widgets: [{ key: "fleet", widget: ["a"] }] }),
      chrome: { ...chrome, pinned: true },
    });
    expect(floatContentChanged(base, pinned)).toBe(true);
  });
});

describe("isIntentForSlot", () => {
  it("accepts intent about the slot the window was opened for", () => {
    expect(isIntentForSlot({ kind: "close", slotId: "a:widget" }, "a:widget")).toBe(true);
  });

  it("rejects intent aimed at another slot", () => {
    expect(isIntentForSlot({ kind: "close", slotId: "b:widget" }, "a:widget")).toBe(false);
  });
});

describe("appendFrameTail", () => {
  it("appends in order so a terminal replay reads the same as the live stream", () => {
    expect(appendFrameTail(appendFrameTail("", "one"), "two")).toBe("onetwo");
  });

  it("keeps the newest output when a stream nobody is reading grows past the cap", () => {
    const tail = appendFrameTail("a".repeat(MAX_FLOAT_FRAME_TAIL_BYTES), "bcd");
    expect(tail).toHaveLength(MAX_FLOAT_FRAME_TAIL_BYTES);
    expect(tail.endsWith("bcd")).toBe(true);
    expect(tail.startsWith("a")).toBe(true);
  });

  it("leaves a stream under the cap untouched", () => {
    const under = "x".repeat(MAX_FLOAT_FRAME_TAIL_BYTES - 1);
    expect(appendFrameTail(under, "")).toBe(under);
  });
});
