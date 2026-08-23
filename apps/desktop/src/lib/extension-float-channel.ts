import type { AppLanguage } from "./i18n";
import type { LiveStatusContent, LiveWidgetContent } from "./extension-ui-slots";
import type { ExtensionPresentationSlot, PresentationSlotMount } from "./extension-ui-slots";
import type { ScreenRect } from "@pideck/protocol";

/**
 * The thin-client channel between the main window and a detached Extension
 * Float (extension-deck.md, "Detached float windows").
 *
 * The main window stays the only Host client and the only writer of
 * DesktopSettings. A Float renders what it is handed and reports what the user
 * did; it never resolves a presentation, writes a preference, or talks to the
 * Host. Everything crossing this boundary is therefore either *content the
 * Float should draw* or *intent the main window should act on* — never state
 * the Float owns.
 *
 * This module is the message contract plus pure builders. The transport
 * bindings live in `extension-float-transport.ts` so the shapes stay testable
 * without a window.
 */

/** Emitted by the main window, addressed to one Float window. */
export const FLOAT_CONTENT_EVENT = "pideck:float-content";
/** Emitted by a Float window, addressed to the main window. */
export const FLOAT_INTENT_EVENT = "pideck:float-intent";
/**
 * `custom()` terminal output, main window to one Float window. Separate from
 * content because frames are high-frequency during a TUI animation and must not
 * drag the whole payload along behind them.
 */
export const FLOAT_FRAME_EVENT = "pideck:float-frame";

/**
 * How much `custom()` output a Float relay retains while no terminal is reading
 * it. Mirrors the in-window frame bus: keep the tail, because the newest output
 * is what a repaint needs.
 */
export const MAX_FLOAT_FRAME_TAIL_BYTES = 2 * 1024 * 1024;

export type FloatChrome = {
  /** Window title and the surface's accessible name. */
  label: string;
  language: AppLanguage | undefined;
  theme: "light" | "dark";
  themeFamily: string;
  reducedMotion: boolean;
  pinned: boolean;
};

/**
 * What a Float draws. A `custom` family Float carries no rows: its content is
 * the frame stream, which is relayed separately so a burst of frames never
 * re-sends the widget payload.
 */
export type FloatContentBody =
  | { kind: "widgets"; widgets: LiveWidgetContent[] }
  | { kind: "statuses"; statuses: LiveStatusContent[] }
  | { kind: "custom"; requestId: string }
  | { kind: "empty" };

export type FloatContentMessage = {
  slotId: string;
  family: ExtensionPresentationSlot["family"];
  chrome: FloatChrome;
  body: FloatContentBody;
};

export type FloatIntent =
  /**
   * This window is mounted and listening. Sent on mount and again after any
   * reload, because content is only pushed when it changes — without this a
   * reloaded Float would wait forever for a message the main window has
   * already decided it does not need to re-send.
   */
  | { kind: "hello"; slotId: string }
  | { kind: "close"; slotId: string }
  | { kind: "togglePin"; slotId: string }
  /** The user moved or resized the window; the main window persists it. */
  | { kind: "geometry"; slotId: string; rect: ScreenRect }
  /**
   * The user picked a destination from the Float's own placement list. Only the
   * choice crosses, never a resolved home: the main window owns what a choice
   * means, so a Float cannot invent a placement the family does not allow.
   */
  | { kind: "setPlacement"; slotId: string; choice: string }
  | { kind: "customInput"; slotId: string; requestId: string; data: string }
  | {
      kind: "customResize";
      slotId: string;
      requestId: string;
      cols: number;
      rows: number;
    }
  /**
   * The Float's terminal is mounted and listening. Sent on mount and again
   * after a window reload, so the main window knows when replaying retained
   * output will actually be drawn rather than dropped.
   */
  | { kind: "customReady"; slotId: string; requestId: string };

/** One chunk of `custom()` output on its way to a Float window. */
export type FloatFrameMessage = { slotId: string; requestId: string; data: string };

export function floatContentBody(mount: PresentationSlotMount): FloatContentBody {
  if (mount.widgets?.length) return { kind: "widgets", widgets: [...mount.widgets] };
  if (mount.statuses?.length) return { kind: "statuses", statuses: [...mount.statuses] };
  if (mount.custom) return { kind: "custom", requestId: mount.custom.requestId };
  return { kind: "empty" };
}

export function floatContentMessage(input: {
  slot: ExtensionPresentationSlot;
  mount: PresentationSlotMount;
  chrome: FloatChrome;
}): FloatContentMessage {
  return {
    slotId: input.slot.slotId,
    family: input.slot.family,
    chrome: input.chrome,
    body: floatContentBody(input.mount),
  };
}

/**
 * Whether a re-send is worth the IPC. Content updates arrive on every store
 * change, and most of them do not touch the Float being drawn.
 */
export function floatContentChanged(
  previous: FloatContentMessage | undefined,
  next: FloatContentMessage,
): boolean {
  if (!previous) return true;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

/** A Float may only report intent about the slot it was opened for. */
export function isIntentForSlot(intent: FloatIntent, slotId: string): boolean {
  return intent.slotId === slotId;
}

/** Retain the newest output only; an unread stream must not grow without bound. */
export function appendFrameTail(previous: string, chunk: string): string {
  const joined = previous + chunk;
  return joined.length > MAX_FLOAT_FRAME_TAIL_BYTES
    ? joined.slice(-MAX_FLOAT_FRAME_TAIL_BYTES)
    : joined;
}
