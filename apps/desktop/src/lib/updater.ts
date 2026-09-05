/**
 * App self-update over the Tauri updater plugin.
 *
 * All plugin imports stay dynamic so the browser mock never loads Tauri
 * internals. A check returns null when no update is available (or when
 * running outside Tauri); installing downloads the package and relaunches.
 */

export type AppUpdate = {
  version: string;
  /** Downloads, installs and relaunches the app. Resolves only on failure paths. */
  install: (onProgress?: (progress: AppUpdateInstallProgress) => void) => Promise<void>;
};

export type AppUpdateInstallProgress =
  | {
      phase: "downloading";
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { phase: "installing" };

let inFlightCheck: Promise<AppUpdate | null> | null = null;

async function runCheck(): Promise<AppUpdate | null> {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return null;

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    install: async (onProgress) => {
      const { ensureFileCanLeave } = await import("../features/dock/file-session");
      if (!(await ensureFileCanLeave())) throw new Error("Update cancelled");
      let downloadedBytes = 0;
      let totalBytes: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          totalBytes = event.data.contentLength ?? null;
          onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
          return;
        }
        onProgress?.({ phase: "installing" });
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      if (!(await ensureFileCanLeave())) throw new Error("Restart cancelled");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_allow_exit", { approved: true });
      try {
        await relaunch();
      } finally {
        await invoke("desktop_allow_exit", { approved: false });
      }
    },
  };
}

/** Checks the release feed; concurrent callers share one in-flight request. */
export function checkForAppUpdate(): Promise<AppUpdate | null> {
  if (!inFlightCheck) {
    inFlightCheck = runCheck().finally(() => {
      inFlightCheck = null;
    });
  }
  return inFlightCheck;
}
