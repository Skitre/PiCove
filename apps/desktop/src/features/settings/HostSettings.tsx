import { useEffect, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { secondaryButton } from "../../components/Dialog";
import { SectionHeader } from "../../components/SectionHeader";
import { getAppVersion } from "../../lib/app-version";
import { checkForAppUpdate, type AppUpdate } from "../../lib/updater";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { RestartHostButton } from "./restart-host";

const CAPABILITY_LABELS: Record<string, MessageKey> = {
  packageUpdateCheck: "hostCapPackageUpdateCheck",
  extensionUi: "hostCapExtensionUi",
  sessionExport: "hostCapSessionExport",
};

export function HostSettings() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const updatePhase = useAppStore((s) => s.appUpdatePhase);
  const setUpdatePhase = useAppStore((s) => s.setAppUpdatePhase);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openAgentDir() {
    if (!host?.agentDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path: host.agentDir });
    } catch (err) {
      pushNotification(err instanceof Error ? err.message : t("notifAgentDirOpenFailed"), "error");
    }
  }

  async function changeAgentDir() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: host?.agentDir });
      if (typeof picked !== "string" || picked === host?.agentDir) return;
      await persistDesktopSettings({ agentDir: picked });
      pushNotification(t("notifAgentDirChanged"), "warning");
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : t("notifAgentDirChangeFailed"),
        "error",
      );
    }
  }

  async function checkForUpdates() {
    setUpdatePhase({ state: "checking" });
    try {
      const update = await checkForAppUpdate();
      setUpdatePhase(update ? { state: "available", update } : { state: "upToDate" });
    } catch (err) {
      setUpdatePhase({ state: "idle" });
      pushNotification(
        err instanceof Error
          ? `${t("notifUpdateCheckFailed")}: ${err.message}`
          : t("notifUpdateCheckFailed"),
        "error",
      );
    }
  }

  async function installUpdate(update: AppUpdate) {
    setUpdatePhase({
      state: "downloading",
      update,
      downloadedBytes: 0,
      totalBytes: null,
    });
    try {
      // On success the app relaunches, so this promise never settles visibly.
      await update.install((progress) => {
        setUpdatePhase(
          progress.phase === "installing"
            ? { state: "installing", update }
            : {
                state: "downloading",
                update,
                downloadedBytes: progress.downloadedBytes,
                totalBytes: progress.totalBytes,
              },
        );
      });
    } catch (err) {
      setUpdatePhase({ state: "available", update });
      pushNotification(
        err instanceof Error
          ? `${t("notifUpdateInstallFailed")}: ${err.message}`
          : t("notifUpdateInstallFailed"),
        "error",
      );
    }
  }

  const updatePercent =
    updatePhase.state === "installing"
      ? 100
      : updatePhase.state === "downloading" &&
          updatePhase.totalBytes !== null &&
          updatePhase.totalBytes > 0
        ? Math.min(100, Math.round((updatePhase.downloadedBytes / updatePhase.totalBytes) * 100))
        : null;
  const updateStatusText =
    updatePhase.state === "installing"
      ? t("hostUpdateInstalling")
      : updatePhase.state === "downloading"
        ? t("hostUpdateDownloading")
        : null;
  const updateProgressLabel =
    updatePhase.state === "downloading" && updatePercent !== null
      ? t("hostUpdateProgress", { percent: updatePercent })
      : updateStatusText;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionHeader title={t("navHost")} subtitle={t("hostSubtitle")} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostRuntimeGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">SDK</span>
                <span className="font-mono">{host?.sdkVersion ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Node</span>
                <span className="font-mono">{host?.nodeVersion ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t("hostPhase")}</span>
                <span>{host?.phase ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="shrink-0 text-muted">{t("hostAgentDir")}</span>
                <span className="truncate font-mono text-xs" title={host?.agentDir}>
                  {host?.agentDir ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t("hostModelConfig")}</span>
                <span
                  className={
                    host?.modelConfigHealth?.state === "ok" ? "text-success" : "text-warning"
                  }
                  title={host?.modelConfigHealth?.message}
                >
                  {host?.modelConfigHealth?.state ?? "—"}
                </span>
              </div>
              {host?.modelConfigHealth?.state === "degraded" && (
                <p className="text-xs text-warning">{t("hostModelConfigDegraded")}</p>
              )}
              {host?.modelConfigHealth?.migrationHint && (
                <p className="text-xs text-warning">
                  {host.modelConfigHealth.migrationHint.message}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void openAgentDir()}
                >
                  {t("hostOpenAgentDir")}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void changeAgentDir()}
                >
                  {t("hostChangeAgentDir")}
                </button>
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <RestartHostButton
                  className={`${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`}
                />
                <p className="mt-1.5 text-xs text-muted">{t("hostRestartCaption")}</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostCapabilitiesGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              {host ? (
                Object.entries(host.capabilities).map(([key, enabled]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted">
                      {CAPABILITY_LABELS[key] ? t(CAPABILITY_LABELS[key]) : key}
                    </span>
                    <span className={enabled ? "text-success" : "text-muted"}>
                      {enabled ? t("commonEnabled") : t("commonUnavailable")}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted">{t("hostNotConnected")}</p>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostAboutGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">PiCove</span>
                <span className="font-mono">{appVersion ?? "—"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {updatePhase.state === "available" ||
                updatePhase.state === "downloading" ||
                updatePhase.state === "installing" ? (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={updatePhase.state !== "available"}
                    onClick={() => void installUpdate(updatePhase.update)}
                  >
                    {updatePhase.state === "installing"
                      ? t("hostUpdateInstalling")
                      : updatePhase.state === "downloading"
                        ? t("hostUpdateDownloading")
                        : t("hostUpdateInstall")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={updatePhase.state === "checking"}
                    onClick={() => void checkForUpdates()}
                  >
                    {updatePhase.state === "checking"
                      ? t("hostUpdateChecking")
                      : t("hostUpdateCheck")}
                  </button>
                )}
                {updatePhase.state === "upToDate" && (
                  <span className="text-xs text-muted">{t("hostUpdateUpToDate")}</span>
                )}
                {(updatePhase.state === "available" ||
                  updatePhase.state === "downloading" ||
                  updatePhase.state === "installing") && (
                  <span className="text-xs text-muted">
                    {t("hostUpdateAvailable", { version: updatePhase.update.version })}
                  </span>
                )}
              </div>
              {updateStatusText && (
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted">
                    <span>{updateStatusText}</span>
                    {updatePercent !== null && <span className="font-mono">{updatePercent}%</span>}
                  </div>
                  <div
                    className="h-1 overflow-hidden rounded-full bg-surface-overlay"
                    role="progressbar"
                    aria-label={updateProgressLabel ?? undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={updatePercent ?? undefined}
                  >
                    <div
                      className={`h-full bg-accent transition-[width] duration-200 ${
                        updatePercent === null ? "w-1/3 animate-pulse" : ""
                      }`}
                      style={updatePercent === null ? undefined : { width: `${updatePercent}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">{t("hostUpdateBackground")}</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
