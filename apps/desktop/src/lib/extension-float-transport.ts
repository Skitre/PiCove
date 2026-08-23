import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { MonitorDescriptor, ScreenRect } from "@pideck/protocol";
import {
  FLOAT_CONTENT_EVENT,
  FLOAT_FRAME_EVENT,
  FLOAT_INTENT_EVENT,
  type FloatContentMessage,
  type FloatFrameMessage,
  type FloatIntent,
} from "./extension-float-channel";

/**
 * Transport for the detached Float channel. Thin on purpose: the message
 * shapes and every decision about them live in `extension-float-channel.ts`,
 * so the parts worth testing do not need a window.
 *
 * The commands here are refused by the Rust side for any webview that is not
 * the main window, so a Float cannot manage another Float.
 */

export type FloatWindowSnapshot = { slotId: string; label: string };

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listFloatMonitors(): Promise<MonitorDescriptor[] | null> {
  if (!isDesktopRuntime()) return [];
  try {
    return await invoke<MonitorDescriptor[]>("extension_float_monitors");
  } catch {
    // Enumeration failure is different from a real empty topology: callers
    // retain the last known displays and retry instead of tearing windows down.
    return null;
  }
}

export async function openFloatWindow(input: {
  slotId: string;
  rect: ScreenRect;
  title: string;
  alwaysOnTop: boolean;
}): Promise<FloatWindowSnapshot | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invoke<FloatWindowSnapshot>("extension_float_open", {
      slotId: input.slotId,
      rect: input.rect,
      title: input.title,
      alwaysOnTop: input.alwaysOnTop,
    });
  } catch {
    return null;
  }
}

export async function closeFloatWindow(slotId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("extension_float_close", { slotId }).catch(() => undefined);
}

export async function setFloatWindowBounds(slotId: string, rect: ScreenRect): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("extension_float_set_bounds", { slotId, rect }).catch(() => undefined);
}

export async function setFloatWindowAlwaysOnTop(
  slotId: string,
  alwaysOnTop: boolean,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("extension_float_set_always_on_top", { slotId, alwaysOnTop }).catch(() => undefined);
}

/** Main window → one Float window. */
export async function publishFloatContent(
  label: string,
  message: FloatContentMessage,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await emitTo(label, FLOAT_CONTENT_EVENT, message).catch(() => undefined);
}

/** Main window → one Float window, once per `custom()` output chunk. */
export async function publishFloatFrame(label: string, message: FloatFrameMessage): Promise<void> {
  if (!isDesktopRuntime()) return;
  await emitTo(label, FLOAT_FRAME_EVENT, message).catch(() => undefined);
}

/** Float window → main window. */
export async function sendFloatIntent(intent: FloatIntent): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("extension_float_intent", { intent }).catch(() => undefined);
}

export async function subscribeFloatContent(
  handler: (message: FloatContentMessage) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    return await listen<FloatContentMessage>(FLOAT_CONTENT_EVENT, (event) =>
      handler(event.payload),
    );
  } catch {
    return () => {};
  }
}

export async function subscribeFloatIntents(
  handler: (intent: FloatIntent) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    return await listen<FloatIntent>(FLOAT_INTENT_EVENT, (event) => handler(event.payload));
  } catch {
    return () => {};
  }
}

export async function subscribeFloatFrames(
  handler: (message: FloatFrameMessage) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  try {
    return await listen<FloatFrameMessage>(FLOAT_FRAME_EVENT, (event) => handler(event.payload));
  } catch {
    return () => {};
  }
}
