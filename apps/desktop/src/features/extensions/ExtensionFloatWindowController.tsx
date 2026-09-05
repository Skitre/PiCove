import { useEffect, useRef, useState } from "react";
import {
  isPresentationHomeForFamily,
  type DetachedFloatPlacement,
  type MonitorDescriptor,
  type PresentationHome,
  type ScreenRect,
} from "@pideck/protocol";
import { observedExtensionDisplayName } from "../../lib/extension-ui-observation";
import {
  canonicalExtensionUiSettings,
  notifyDesktopSettingsSaveFailure,
  persistExtensionUiSettings,
} from "../../lib/desktop-settings";
import {
  appendFrameTail,
  floatContentChanged,
  floatContentMessage,
  isLiveFloatWidgetKey,
  isLiveFloatWidgetAction,
  type FloatChrome,
  type FloatContentMessage,
  type FloatIntent,
} from "../../lib/extension-float-channel";
import {
  hasExtensionTerminalListener,
  pushExtensionTerminalFrame,
  subscribeExtensionTerminal,
} from "../../lib/chat/extension-terminal-bus";
import { hostClient } from "../../lib/bridge/host-client";
import { dispatchExtensionWidgetAction } from "../../lib/extension-widget-action";
import { latestSessionTargetContext } from "../../lib/bridge/host-context";
import {
  closeFloatWindow,
  listFloatMonitors,
  openFloatWindow,
  publishFloatContent,
  publishFloatFrame,
  setFloatWindowAlwaysOnTop,
  setFloatWindowBounds,
  subscribeFloatIntents,
} from "../../lib/extension-float-transport";
import {
  detachedPlacementFor,
  resolveDetachedPlacement,
} from "../../lib/extension-ui-detached-placement";
import { detachedPlacementForViewportRect } from "../../lib/extension-float-detach";
import { floatRectToPixels } from "../../lib/extension-ui-float-geometry";
import { setWindowedFloats } from "../../lib/extension-float-placement-state";
import {
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "../../lib/extension-ui-home-message";
import {
  isLegalPresentationChoice,
  presentationHomeFromChoice,
} from "../../lib/extension-ui-presentation";
import { commitExtensionPresentationHome, withFamilyHome } from "../../lib/extension-ui-profile";
import {
  mountsForHome,
  type ExtensionPresentationSlot,
  type PresentationSlotMount,
} from "../../lib/extension-ui-slots";
import { useLiveExtensionPresentationSlots } from "../../lib/extension-ui-live-slots";
import { useAppStore } from "../../lib/stores/app-store";
import { resolveEffectiveTheme } from "../../lib/theme";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { closeExtensionTerminalWithFallback } from "../dock/ExtensionTerminal";

type DetachedEntry = { slot: ExtensionPresentationSlot; mount: PresentationSlotMount };

/** Sub-pixel equality: the platform rounds a window rect on the way back out. */
function sameScreenRect(left: ScreenRect, right: ScreenRect): boolean {
  return (
    Math.abs(left.x - right.x) < 1 &&
    Math.abs(left.y - right.y) < 1 &&
    Math.abs(left.width - right.width) < 1 &&
    Math.abs(left.height - right.height) < 1
  );
}

/**
 * The Host context for the live `custom()` panel, or null if that panel is gone.
 *
 * Resolved per request rather than captured when the Float opened: the Host
 * migrates a pending panel across revision bumps, so a stale context would fail
 * request-owner matching while the panel is still very much alive.
 */
function livePanelContext(requestId: string) {
  const state = useAppStore.getState();
  const panel = state.extensionTerminal;
  if (!panel || panel.requestId !== requestId) return null;
  return latestSessionTargetContext(panel.context, state.host, state.workspace, state.session);
}

/**
 * Owns every detached Extension Float window from the main window
 * (extension-deck.md, "Detached float windows").
 *
 * This is the only place a Float window is opened, fed, or closed, because the
 * main window is the only Host client and the only writer of DesktopSettings.
 * A Float reports intent here and this controller performs the settings write,
 * so there is still exactly one writer.
 *
 * Mounted at application level rather than inside Chat: a detached Float stays
 * on screen while the main window shows Settings or another page — that is the
 * point of detaching.
 */
export function ExtensionFloatWindowController() {
  const t = useT();
  const slots = useLiveExtensionPresentationSlots();
  const desktopSettings = useAppStore((state) => state.desktopSettings);
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);

  /** slotId → window label, for windows this controller opened. */
  const open = useRef(new Map<string, string>());
  const lastContent = useRef(new Map<string, FloatContentMessage>());
  /** Placements derived for floats the user has never positioned. Memory only. */
  const promoted = useRef(new Map<string, DetachedFloatPlacement>());
  const monitors = useRef<MonitorDescriptor[]>([]);
  /** Last rect this controller pushed, so an echo cannot fight the user. */
  const appliedRect = useRef(new Map<string, ScreenRect>());
  const entries = useRef<DetachedEntry[]>([]);
  /** Retained `custom()` output per requestId, so a Float can be repainted. */
  const frameTail = useRef(new Map<string, string>());
  const translate = useRef(t);
  translate.current = t;
  // The content push runs on every render and re-sends only what changed, so a
  // Float reporting in needs nothing but a render. Only the setter is taken —
  // the count itself is never read.
  const rerender = useState(0)[1];
  const [monitorTopologyKey, setMonitorTopologyKey] = useState("");

  // Every float wants a window now, whether or not it already carries a
  // placement: a float with none is one the user has not positioned yet (an
  // `overlay: true` custom, or a profile written before floats left the main
  // window). It gets a window over the pixels it would have occupied.
  const detached: DetachedEntry[] = mountsForHome(slots, (home) => home.kind === "float");
  entries.current = detached;
  const detachedKey = JSON.stringify(detached.map(({ slot, mount }) => [slot.slotId, mount.home]));
  // Which frame streams this controller must relay. Keyed apart from
  // `detachedKey` so moving a window cannot tear down a live terminal.
  const customRelayKey = JSON.stringify(
    detached.map(({ slot, mount }) => [slot.slotId, mount.custom?.requestId ?? null]),
  );
  const hasDetached = detached.length > 0;

  // Tauri exposes no portable monitor-topology event. Poll only while a Float
  // is requested; transient enumeration failures preserve the last known
  // topology instead of reattaching every window.
  useEffect(() => {
    if (!hasDetached) {
      monitors.current = [];
      setMonitorTopologyKey("");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const live = await listFloatMonitors();
      if (cancelled) return;
      if (live !== null) {
        monitors.current = live;
        setMonitorTopologyKey(JSON.stringify(live));
      }
      timer = window.setTimeout(refresh, 2_000);
    };
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasDetached]);

  const commitHome = (
    slot: ExtensionPresentationSlot,
    home: PresentationHome | undefined,
    messageKey: MessageKey,
  ) => {
    if (!slot.extensionId) return;
    const t = translate.current;
    void commitExtensionPresentationHome({
      extensionId: slot.extensionId,
      family: slot.family,
      home,
      message: t(messageKey, {
        name: observedExtensionDisplayName(slot.extensionId),
        family: t(extensionUiFamilyMessageKey(slot.family)),
      }),
    }).catch(notifyDesktopSettingsSaveFailure);
  };

  const floatTitle = (slot: ExtensionPresentationSlot): string => {
    const t = translate.current;
    return t("extensionUiFloatLabel", {
      name: slot.extensionId ? observedExtensionDisplayName(slot.extensionId) : slot.slotId,
      family: t(extensionUiFamilyMessageKey(slot.family)),
    });
  };

  // Reconcile windows against the detached slots that currently have content.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const live = monitors.current;
      const wanted = new Set<string>();

      for (const { slot, mount } of entries.current) {
        if (mount.home.kind !== "float") continue;
        // A float with no stored placement gets one derived from where it is
        // drawn right now, held in memory only. Persisting it here would turn a
        // resolver default into a saved preference behind the user's back; the
        // geometry intent already persists it once the user moves the window.
        let placement = mount.home.detached ?? promoted.current.get(slot.slotId);
        if (!placement) {
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const pixel = floatRectToPixels(mount.home.rect, viewport);
          placement = await detachedPlacementForViewportRect(pixel, live);
          if (cancelled) return;
          if (placement) promoted.current.set(slot.slotId, placement);
        }
        if (!placement) continue;
        const resolved = resolveDetachedPlacement(placement, live);
        if (resolved.status === "reattach") {
          // The display this Float lived on is gone. Nothing is written: the
          // placement is exactly where the user put it, and the window reopens
          // there when the display returns. Until then the in-window layer
          // draws the float, because it is missing from `wanted`.
          continue;
        }
        wanted.add(slot.slotId);
        if (open.current.has(slot.slotId)) {
          void setFloatWindowAlwaysOnTop(slot.slotId, mount.home.pinned === true);
          // The stored placement can change without the user touching the
          // window — Undo is the obvious case. Move the window to match, but
          // only on a real difference, so a geometry report cannot echo back
          // into the drag the user is still performing.
          const applied = appliedRect.current.get(slot.slotId);
          if (!applied || !sameScreenRect(applied, resolved.rect)) {
            appliedRect.current.set(slot.slotId, resolved.rect);
            void setFloatWindowBounds(slot.slotId, resolved.rect);
          }
          continue;
        }
        const snapshot = await openFloatWindow({
          slotId: slot.slotId,
          rect: resolved.rect,
          title: floatTitle(slot),
          alwaysOnTop: mount.home.pinned === true,
        });
        if (cancelled) return;
        if (snapshot) {
          open.current.set(slot.slotId, snapshot.label);
          appliedRect.current.set(slot.slotId, resolved.rect);
        }
      }

      // A slot whose content ended, or that is no longer detached, releases its
      // window. The preference survives; only the shell goes away.
      for (const slotId of [...open.current.keys()]) {
        if (wanted.has(slotId)) continue;
        open.current.delete(slotId);
        lastContent.current.delete(slotId);
        appliedRect.current.delete(slotId);
        promoted.current.delete(slotId);
        void closeFloatWindow(slotId);
      }

      // Publish what actually has a window, not what wanted one: a platform
      // that refused, or no desktop runtime at all, must still leave the float
      // visible in the main window rather than nowhere.
      setWindowedFloats(open.current.keys());
    })();
    return () => {
      cancelled = true;
    };
  }, [detachedKey, monitorTopologyKey]);

  // Push content whenever what a Float should draw actually changes.
  useEffect(() => {
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const { slot, mount } of detached) {
      const label = open.current.get(slot.slotId);
      if (!label || mount.home.kind !== "float") continue;
      const chrome: FloatChrome = {
        label: floatTitle(slot),
        language: desktopSettings?.language,
        theme: resolveEffectiveTheme(desktopSettings?.theme ?? "system"),
        themeFamily: desktopSettings?.themeFamily ?? "pideck",
        reducedMotion,
        pinned: mount.home.pinned === true,
      };
      const message = floatContentMessage({ slot, mount, chrome, collapsedWidgetKeys });
      if (!floatContentChanged(lastContent.current.get(slot.slotId), message)) continue;
      lastContent.current.set(slot.slotId, message);
      void publishFloatContent(label, message);
    }
  });

  // Relay `custom()` output to the Float that is drawing it. The Float has no
  // Host client, so this is the only way its terminal sees anything.
  useEffect(() => {
    // The Map identity is stable for the controller's lifetime; bind it here so
    // the cleanup cannot read a different one than the subscription wrote to.
    const tails = frameTail.current;
    const relayed: Array<{ slotId: string; requestId: string }> = [];
    for (const { slot, mount } of entries.current) {
      if (mount.custom) relayed.push({ slotId: slot.slotId, requestId: mount.custom.requestId });
    }
    const disposers = relayed.map(({ slotId, requestId }) =>
      subscribeExtensionTerminal(requestId, (chunk) => {
        tails.set(requestId, appendFrameTail(tails.get(requestId) ?? "", chunk));
        const label = open.current.get(slotId);
        if (label) void publishFloatFrame(label, { slotId, requestId, data: chunk });
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
      // Hand the retained output back on the way out, so re-attaching shows the
      // panel rather than an empty terminal — a TUI repaints only when asked.
      // Skipped once the panel is gone (nothing would ever read the buffer) or
      // while a terminal is already listening (it would be written twice).
      for (const { requestId } of relayed) {
        const tail = tails.get(requestId);
        tails.delete(requestId);
        if (!tail) continue;
        const live = useAppStore.getState().extensionTerminal?.requestId === requestId;
        if (live && !hasExtensionTerminalListener(requestId)) {
          pushExtensionTerminalFrame(requestId, tail);
        }
      }
    };
  }, [customRelayKey]);

  // Act on what a Float's user did. Every branch ends in a settings write
  // performed here, never in the Float.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeFloatIntents((intent: FloatIntent) => {
      const entry = entries.current.find(({ slot }) => slot.slotId === intent.slotId);
      if (!entry || entry.mount.home.kind !== "float") return;
      const { slot } = entry;
      const mount = entry.mount;
      const home = entry.mount.home;
      switch (intent.kind) {
        case "hello":
          // The window is listening again. Forget what it was last sent so the
          // push below treats its content as new, and re-render to run it.
          lastContent.current.delete(intent.slotId);
          rerender((value) => value + 1);
          return;
        case "focus":
          window.dispatchEvent(
            new CustomEvent("pideck:float-focus", {
              detail: { slotId: intent.slotId, focused: intent.focused },
            }),
          );
          return;
        case "close":
          if (mount.custom) {
            const panel = useAppStore.getState().extensionTerminal;
            if (panel && panel.requestId === mount.custom.requestId) {
              void closeExtensionTerminalWithFallback(panel).then((error) => {
                if (error) useAppStore.getState().pushNotification(error, "error");
              });
            }
            return;
          }
          commitHome(slot, { kind: "hidden" }, "extensionUiMovedToHidden");
          return;
        case "togglePin":
          commitHome(slot, { ...home, pinned: !home.pinned }, "extensionUiChangedHome");
          return;
        case "setPlacement": {
          // The Float sent a choice; what it means is decided here, against the
          // family's own legal list, so an out-of-band intent cannot place a
          // slot somewhere its family forbids.
          if (!isLegalPresentationChoice(slot.family, intent.choice)) return;
          const settings = canonicalExtensionUiSettings(useAppStore.getState().desktopSettings);
          const next = presentationHomeFromChoice(slot.family, intent.choice, settings, home);
          if (!isPresentationHomeForFamily(slot.family, next)) return;
          commitHome(slot, next, extensionUiHomeMessageKey(next));
          return;
        }
        case "geometry": {
          const extensionId = slot.extensionId;
          if (!extensionId) return;
          const placement = detachedPlacementFor(intent.rect, monitors.current);
          if (!placement) return;
          // Moving or resizing a native window is routine placement memory,
          // not a presentation change that needs another Undo toast.
          void persistExtensionUiSettings((current) =>
            withFamilyHome(current, extensionId, slot.family, { ...home, detached: placement }),
          ).catch(notifyDesktopSettingsSaveFailure);
          return;
        }
        case "widgetAction": {
          if (!slot.extensionId || !isLiveFloatWidgetAction(mount, intent.key, intent.actionId))
            return;
          // Rust binds the sender to its slot. Derive the Extension here rather
          // than accepting an identity supplied by the detached renderer.
          void dispatchExtensionWidgetAction(slot.extensionId, intent.key, intent.actionId).then(
            (error) => {
              if (error) useAppStore.getState().pushNotification(error, "error");
            },
          );
          return;
        }
        case "toggleWidgetCollapsed": {
          if (!isLiveFloatWidgetKey(mount, intent.key)) return;
          useAppStore.getState().toggleExtensionWidgetCollapsed(intent.key);
          return;
        }
        case "customReady": {
          if (mount.custom?.requestId !== intent.requestId) return;
          // The Float's terminal is listening now, so what arrived while it was
          // still mounting can finally be drawn.
          const label = open.current.get(slot.slotId);
          const tail = frameTail.current.get(intent.requestId);
          if (!label || !tail) return;
          void publishFloatFrame(label, {
            slotId: slot.slotId,
            requestId: intent.requestId,
            data: tail,
          });
          return;
        }
        case "customInput": {
          if (mount.custom?.requestId !== intent.requestId) return;
          const context = livePanelContext(intent.requestId);
          if (!context) return;
          void hostClient
            .request("extensionUi.customInput", context, {
              requestId: intent.requestId,
              data: intent.data,
            })
            .catch(() => undefined);
          return;
        }
        case "customResize": {
          if (mount.custom?.requestId !== intent.requestId) return;
          const context = livePanelContext(intent.requestId);
          if (!context) return;
          void hostClient
            .request("extensionUi.customResize", context, {
              requestId: intent.requestId,
              cols: intent.cols,
              rows: intent.rows,
            })
            .catch(() => undefined);
          return;
        }
        default:
          return;
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
    // A `useState` setter is stable for the component's lifetime, so listing it
    // cannot re-subscribe; it only satisfies the rule.
  }, [rerender]);

  return null;
}
