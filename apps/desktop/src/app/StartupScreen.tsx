import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "../lib/i18n";
import { useT } from "../lib/i18n/use-t";
import { PiMark } from "../components/PiMark";

export type StartupStage =
  | "preparing"
  | "starting-host"
  | "restoring-workspace"
  | "restoring-session"
  | "reconnecting"
  | "ready";

export type StartupPhase = "active" | "exiting" | "complete";

const STARTUP_MIN_VISIBLE_MS = 360;
const STARTUP_EXIT_MS = 200;

const STAGE_LABELS: Record<StartupStage, MessageKey> = {
  preparing: "startupPreparing",
  "starting-host": "startupStartingHost",
  "restoring-workspace": "startupRestoringWorkspace",
  "restoring-session": "startupRestoringSession",
  reconnecting: "startupReconnecting",
  ready: "startupReady",
};

export function resolveStartupStage(args: {
  settingsReady: boolean;
  hostReady: boolean;
  workspaceReady: boolean;
  sessionReady: boolean;
  connecting: boolean;
  rehydrating: boolean;
  desynchronized: boolean;
}): StartupStage {
  if (!args.settingsReady) return "preparing";
  if (args.desynchronized) return "reconnecting";
  if (args.rehydrating) {
    return args.workspaceReady || args.sessionReady ? "restoring-session" : "restoring-workspace";
  }
  if (args.connecting && !args.hostReady) return "starting-host";
  if (args.connecting && !args.workspaceReady) return "restoring-workspace";
  if (args.connecting) return "restoring-session";
  return "ready";
}

export function useInitialStartupScreen(
  bootstrapSettled: boolean,
  timings: { minimumMs?: number; exitMs?: number } = {},
): StartupPhase {
  const minimumMs = timings.minimumMs ?? STARTUP_MIN_VISIBLE_MS;
  const exitMs = timings.exitMs ?? STARTUP_EXIT_MS;
  const mountedAt = useRef(Date.now());
  const [phase, setPhase] = useState<StartupPhase>("active");

  useEffect(() => {
    if (!bootstrapSettled || phase !== "active") return;
    const remaining = Math.max(0, minimumMs - (Date.now() - mountedAt.current));
    const timer = window.setTimeout(() => setPhase("exiting"), remaining);
    return () => window.clearTimeout(timer);
  }, [bootstrapSettled, minimumMs, phase]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = window.setTimeout(() => setPhase("complete"), exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, phase]);

  return phase;
}

export function StartupScreen({ stage, exiting }: { stage: StartupStage; exiting: boolean }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!exiting}
      data-startup-screen
      data-startup-stage={stage}
      data-startup-exiting={exiting ? "true" : "false"}
      className={`startup-screen ${exiting ? "startup-screen--exiting" : ""}`}
    >
      <div className="startup-drag-region" data-tauri-drag-region />
      <div className="startup-content">
        <PiMark className="startup-mark" />
        <span className="startup-wordmark">PiCove</span>
        <div className="startup-progress" aria-hidden="true">
          <span className="startup-progress-value" />
        </div>
        <span className="startup-status">{t(STAGE_LABELS[stage])}</span>
      </div>
    </div>
  );
}
