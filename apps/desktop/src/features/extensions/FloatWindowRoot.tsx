import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LayoutGrid, Pin, X } from "lucide-react";
import type { ScreenRect } from "@pideck/protocol";
import { type FloatContentMessage, type FloatIntent } from "../../lib/extension-float-channel";
import {
  sendFloatIntent,
  subscribeFloatContent,
  subscribeFloatFrames,
} from "../../lib/extension-float-transport";
import { XtermSurface } from "../dock/XtermSurface";
import { matchesCommandChord } from "../../lib/commands/keymap";
import { MenuHost } from "../../components/Menu";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { FAMILY_PRESENTATION_CHOICES } from "../../lib/extension-ui-presentation";
import { extensionUiChoiceMessageKey } from "../../lib/extension-ui-home-message";
import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import { rendererFormFor } from "../../lib/extension-ui-renderer-form";
import { applyTheme, type AppThemeFamily } from "../../lib/theme";
import { applyLanguage } from "../../lib/i18n";
import { applyFontPreferences, invalidateFontLibrary } from "../../lib/fonts";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionStatusRows, ExtensionWidgetRows } from "./ExtensionWidgetContent";
import { ExtensionFloatTitleBar, ExtensionFloatTitleBarButton } from "./ExtensionFloatChrome";

/**
 * The root of a detached Extension Float window (extension-deck.md, "Detached
 * float windows").
 *
 * A thin client. It holds no session, workspace, or agent state, never
 * subscribes to the Host event stream, and never issues a Host request or a
 * settings write. It draws what the main window forwards and reports what the
 * user did; the main window decides what that means.
 *
 * Content renders through the same renderers as the in-window float layer, so
 * the two containers cannot drift apart.
 */
type PlacementMenuAnchor = { clientX: number; clientY: number; target: EventTarget | null };

export function FloatWindowRoot({ slotId }: { slotId: string }) {
  const t = useT();
  const [message, setMessage] = useState<FloatContentMessage | null>(null);
  const setSurfaceLanguage = useAppStore((state) => state.setSurfaceLanguage);
  const geometryTimer = useRef<number | undefined>(undefined);
  const fontsRevision = useRef<number | undefined>(undefined);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeFloatContent((next) => {
      // The main window addresses this window directly, but a stale message for
      // another slot must never repaint this one.
      if (next.slotId !== slotId) return;
      setMessage(next);
      // The forwarded language reaches the shared renderers through the store,
      // so a Float translates exactly like the in-window float layer.
      setSurfaceLanguage(next.chrome.language);
      applyLanguage(next.chrome.language);
      applyTheme(next.chrome.theme, {
        family: next.chrome.themeFamily as AppThemeFamily,
        persist: false,
      });
      if (fontsRevision.current !== next.chrome.fontLibraryRevision) {
        fontsRevision.current = next.chrome.fontLibraryRevision;
        invalidateFontLibrary();
      }
      applyFontPreferences(next.chrome.fontPreferences, false);
      document.title = next.chrome.label;
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else {
        dispose = unlisten;
        // Only now can a message land. Content is pushed on change, so a window
        // that reloaded would otherwise sit empty forever: the main window has
        // already sent this slot's content and will not send it again.
        void sendFloatIntent({ kind: "hello", slotId });
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [slotId, setSurfaceLanguage]);

  // Report the window's own geometry after the user finishes moving or resizing
  // it. Debounced, because the platform emits a burst during a drag and the
  // main window writes settings once per committed change, never continuously.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      // The whole handshake is guarded, not just the import: outside a desktop
      // runtime the module loads fine and `getCurrentWindow()` is what throws,
      // which surfaced as an unhandled rejection rather than a quiet no-op.
      let current: import("@tauri-apps/api/window").Window;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        current = getCurrentWindow();
      } catch {
        return;
      }
      const commit = () => {
        window.clearTimeout(geometryTimer.current);
        geometryTimer.current = window.setTimeout(() => {
          void (async () => {
            try {
              const [position, size, scale] = await Promise.all([
                current.outerPosition(),
                current.innerSize(),
                current.scaleFactor(),
              ]);
              const factor =
                resolveWindowControlsPlatform() === "windows" ? 1 : scale > 0 ? scale : 1;
              const rect: ScreenRect = {
                x: position.x / factor,
                y: position.y / factor,
                width: size.width / factor,
                height: size.height / factor,
              };
              void sendFloatIntent({ kind: "geometry", slotId, rect });
            } catch {
              // A window mid-teardown cannot report geometry; the stored
              // placement simply stays where it was.
            }
          })();
        }, 250);
      };
      try {
        const unlistenMoved = await current.onMoved(commit);
        const unlistenResized = await current.onResized(commit);
        const unlistenClose = await current.onCloseRequested((event) => {
          // Native destruction would bypass the main-window owner and leave a
          // live custom() promise plus stale manager state. Route the same
          // close intent as the title-bar button; the controller destroys the
          // native window after the content/promise has settled.
          event.preventDefault();
          void sendFloatIntent({ kind: "close", slotId });
        });
        if (cancelled) {
          unlistenMoved();
          unlistenResized();
          unlistenClose();
          return;
        }
        dispose = () => {
          unlistenMoved();
          unlistenResized();
          unlistenClose();
        };
      } catch {
        // A window that cannot report its own geometry simply keeps the
        // placement it was opened with.
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(geometryTimer.current);
      dispose?.();
    };
  }, [slotId]);

  // The main window owns native notifications, but a focused Float is still
  // PiDeck in the foreground. Relay focus changes so the main window can
  // suppress duplicate OS alerts while the user is looking at this surface.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          void sendFloatIntent({ kind: "focus", slotId, focused });
        });
        if (cancelled) unlisten();
        else dispose = unlisten;
      } catch {
        // Browser/test surfaces do not expose native focus events.
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [slotId]);

  const intent = (next: FloatIntent) => void sendFloatIntent(next);

  /**
   * The same destinations the main window offers, minus the one this window
   * already is. Only the choice is sent: the main window decides what it means
   * and performs the write, so this stays a thin client.
   */
  const placementMenu = useRef<(event: PlacementMenuAnchor) => void>(() => {});
  const openPlacementMenu = (event: PlacementMenuAnchor) => {
    const family = message?.family;
    if (!family) return;
    const items = FAMILY_PRESENTATION_CHOICES[family]
      .filter((choice) => choice !== "float")
      .filter((choice) => !(choice === "hidden" && family !== "widget"))
      .map((choice) => ({
        id: `float-placement-${choice}`,
        label: t(extensionUiChoiceMessageKey(choice)),
        onSelect: () => intent({ kind: "setPlacement", slotId, choice }),
      }));
    if (items.length === 0) return;
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      trigger: contextMenuTrigger(event.target),
      items,
    });
  };
  placementMenu.current = openPlacementMenu;

  // Keyboard re-attach. A `custom()` Float is a terminal that swallows Tab, so
  // the title-bar buttons are not otherwise keyboard-reachable there. Capture
  // phase for the same reason: the chord must win before xterm sees the key.
  useEffect(() => {
    const isMac = resolveWindowControlsPlatform() === "macos";
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesCommandChord(event, "mod+shift+d", isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      const button = document.querySelector<HTMLElement>(
        '[data-extension-float-control="placement"]',
      );
      const rect = button?.getBoundingClientRect();
      placementMenu.current({
        clientX: rect ? rect.left : 8,
        clientY: rect ? rect.bottom : 32,
        target: button ?? null,
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [slotId]);

  /**
   * The title bar and blank space around the content hand dragging to the
   * platform. Batch 6 replaces this with pointer-driven positioning: a native
   * drag loop delivers no pointer movement, so it cannot hit-test the main
   * window's drop targets.
   */
  const startWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => undefined);
  };

  const onBodyPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Only the shell's own blank space moves the window. Content and its
    // scrollbar keep their native selection, scrolling, and input gestures.
    if (event.target !== event.currentTarget) return;
    startWindowDrag(event);
  };

  const label = message?.chrome.label ?? slotId;
  const pinned = message?.chrome.pinned === true;

  return (
    <div
      data-extension-float-window={slotId}
      className="flex h-screen w-screen flex-col overflow-hidden border border-border bg-surface-raised"
    >
      <ExtensionFloatTitleBar label={label} onPointerDown={startWindowDrag}>
        <ExtensionFloatTitleBarButton
          label={t(pinned ? "extensionUiFloatUnpin" : "extensionUiFloatPin", {
            name: label,
            family: "",
          })}
          icon={Pin}
          active={pinned}
          onClick={() => intent({ kind: "togglePin", slotId })}
        />
        <ExtensionFloatTitleBarButton
          label={t("extensionUiPlacementMenu", { name: label, family: "" })}
          icon={LayoutGrid}
          dataKey="placement"
          onClick={openPlacementMenu}
        />
        <ExtensionFloatTitleBarButton
          label={t("extensionUiFloatClose", { name: label, family: "" })}
          icon={X}
          onClick={() => intent({ kind: "close", slotId })}
        />
      </ExtensionFloatTitleBar>
      <div
        data-extension-float-body
        onPointerDown={onBodyPointerDown}
        className={
          message?.body.kind === "custom"
            ? "flex min-h-0 flex-1 cursor-grab flex-col p-2"
            : "flex min-h-0 flex-1 cursor-grab flex-col px-3 py-2"
        }
      >
        <div
          className={
            message?.body.kind === "custom"
              ? "flex min-h-0 flex-1 cursor-auto overflow-hidden"
              : "min-h-0 cursor-auto overflow-auto"
          }
        >
          <FloatBody message={message} waiting={t("extensionUiFloatWaiting")} />
        </div>
      </div>
      <MenuHost />
    </div>
  );
}

function FloatBody({ message, waiting }: { message: FloatContentMessage | null; waiting: string }) {
  const t = useT();
  if (message?.body.kind === "widgets") {
    return (
      <ExtensionWidgetRows
        widgets={message.body.widgets}
        form={rendererFormFor("widget", "float")}
        collapsedWidgetKeys={message.body.collapsedWidgetKeys}
        onToggleCollapsed={(key) =>
          void sendFloatIntent({ kind: "toggleWidgetCollapsed", slotId: message.slotId, key })
        }
        onAction={async (_extensionId, key, actionId) => {
          try {
            await sendFloatIntent({
              kind: "widgetAction",
              slotId: message.slotId,
              key,
              actionId,
            });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : t("extensionWidgetActionFailed");
          }
        }}
      />
    );
  }
  if (message?.body.kind === "statuses") {
    return (
      <ExtensionStatusRows
        statuses={message.body.statuses}
        form={rendererFormFor("status", "float")}
      />
    );
  }
  if (message?.body.kind === "custom") {
    return (
      <FloatTerminal
        key={message.body.requestId}
        slotId={message.slotId}
        requestId={message.body.requestId}
      />
    );
  }
  return (
    <p data-extension-float-waiting className="text-xs text-muted">
      {waiting}
    </p>
  );
}

/** How long a Float's terminal must hold a size before the Host hears about it. */
const RESIZE_SETTLE_MS = 120;

/**
 * A detached `custom()` panel. Identical in behaviour to the in-window
 * terminal, except that every side of the conversation is relayed: output
 * arrives as forwarded frames instead of Host events, and keystrokes leave as
 * intent instead of Host requests. The Float still owns no Host client.
 */
function FloatTerminal({ slotId, requestId }: { slotId: string; requestId: string }) {
  return (
    <XtermSurface
      sessionKey={`float:${requestId}`}
      visible
      cursorBlink={false}
      connect={(term) => {
        const dataSub = term.onData((data) => {
          if (!data) return;
          void sendFloatIntent({ kind: "customInput", slotId, requestId, data });
        });

        // Every resize the Float reports becomes a Host request in the main
        // window, and a Float is resized by dragging a window edge — the
        // measured cost of not coalescing was 17 requests for a single mount.
        // Only the size the terminal settles on is worth telling the Host about.
        let sent = { cols: 0, rows: 0 };
        let resizeTimer: number | undefined;
        const reportSize = (cols: number, rows: number) => {
          if (cols <= 0 || rows <= 0) return;
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            if (cols === sent.cols && rows === sent.rows) return;
            sent = { cols, rows };
            void sendFloatIntent({ kind: "customResize", slotId, requestId, cols, rows });
          }, RESIZE_SETTLE_MS);
        };
        const resizeSub = term.onResize(({ cols, rows }) => reportSize(cols, rows));
        let disposed = false;
        let unlistenFrames: (() => void) | undefined;
        void subscribeFloatFrames((frame) => {
          if (frame.requestId !== requestId) return;
          term.write(frame.data);
        }).then((dispose) => {
          if (disposed) {
            dispose();
            return;
          }
          unlistenFrames = dispose;
          // Announce only once frames can actually land, so the retained output
          // the main window replays is drawn instead of dropped. The resize is
          // what makes the component repaint at this window's size rather than
          // the size it was started at.
          void sendFloatIntent({ kind: "customReady", slotId, requestId });
          reportSize(term.cols, term.rows);
        });
        return () => {
          disposed = true;
          window.clearTimeout(resizeTimer);
          dataSub.dispose();
          resizeSub.dispose();
          unlistenFrames?.();
        };
      }}
    />
  );
}
