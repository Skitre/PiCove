import { useEffect, useMemo, useRef } from "react";
import {
  flushDraftWrites,
  hydrateDraftWorkspace,
  settleDraftWritesWithin,
} from "../lib/draft-persistence";
import { draftKeyForTarget, draftTargetFor } from "../lib/draft-target";
import { useAppStore } from "../lib/stores/app-store";
import { ensureFileCanLeave, fileIsDirty } from "../features/dock/file-session";

export function shouldAwaitDraftFlushOnClose(
  tauriPlatform = import.meta.env.TAURI_ENV_PLATFORM,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  const platform = tauriPlatform?.toLowerCase();
  if (platform) return platform !== "windows" && platform !== "win32";
  return !/Windows/i.test(userAgent);
}

type CloseRequest = {
  preventDefault: () => void;
};

type ClosingWindow = {
  hide: () => Promise<void>;
  destroy: () => Promise<void>;
};

export async function closeWindowAfterDraftFlush(
  event: CloseRequest,
  appWindow: ClosingWindow,
  settleDraftWrites = settleDraftWritesWithin,
): Promise<void> {
  event.preventDefault();
  try {
    await appWindow.hide();
  } catch {
    // Hiding only removes perceived close latency; it must not block shutdown.
  }
  try {
    await settleDraftWrites();
  } finally {
    await appWindow.destroy();
  }
}

export function DraftPersistenceController() {
  const workspace = useAppStore((state) => state.workspace);
  const session = useAppStore((state) => state.session);
  const clearDraftWorkspace = useAppStore((state) => state.clearDraftWorkspace);
  const previousCanonicalCwd = useRef<string | null>(null);
  const targetKey = useMemo(() => {
    const target = draftTargetFor(workspace, session);
    return target ? draftKeyForTarget(target) : null;
  }, [session, workspace]);

  useEffect(() => {
    const canonicalCwd = workspace?.canonicalCwd;
    if (!canonicalCwd) return;
    const previous = previousCanonicalCwd.current;
    if (previous && previous !== canonicalCwd) {
      void flushDraftWrites();
      clearDraftWorkspace(previous);
    }
    previousCanonicalCwd.current = canonicalCwd;
    void hydrateDraftWorkspace(canonicalCwd);
  }, [clearDraftWorkspace, workspace?.canonicalCwd]);

  useEffect(
    () => () => {
      void flushDraftWrites();
    },
    [targetKey],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushDraftWrites();
    };
    const flushOnPageHide = () => void flushDraftWrites();
    const preventUnsavedReload = (event: BeforeUnloadEvent) => {
      if (fileIsDirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventUnsavedReload);
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      window.removeEventListener("beforeunload", preventUnsavedReload);
      void flushDraftWrites();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let closing = false;
    let stopListening = () => {};
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { listen } = await import("@tauri-apps/api/event");
      const { invoke } = await import("@tauri-apps/api/core");
      const appWindow = getCurrentWindow();
      const unlisten = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          if (!shouldAwaitDraftFlushOnClose()) await settleDraftWritesWithin();
          if (!(await ensureFileCanLeave())) return;
          if (shouldAwaitDraftFlushOnClose()) await closeWindowAfterDraftFlush(event, appWindow);
          else {
            await appWindow.hide();
          }
        } finally {
          closing = false;
        }
      });
      const unlistenQuit = await listen("desktop-quit-requested", async () => {
        if (closing) return;
        closing = true;
        try {
          await settleDraftWritesWithin();
          if (!(await ensureFileCanLeave())) return;
          await invoke("desktop_exit");
        } finally {
          closing = false;
        }
      });
      if (disposed) {
        unlisten();
        unlistenQuit();
      } else
        stopListening = () => {
          unlisten();
          unlistenQuit();
        };
    })().catch(() => undefined);
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return null;
}
