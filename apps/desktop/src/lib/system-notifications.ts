import type { HostEventEnvelope } from "@pideck/protocol";
import { isTauri } from "@tauri-apps/api/core";
import { tCurrent } from "./i18n/use-t";

export type SystemNotificationKind =
  "response-ready" | "session-failed" | "input-required" | "host-fatal";

export type SystemNotificationTarget = {
  workspaceId: string | null;
  workspaceRevision: number | undefined;
  workspacePath?: string;
  sessionId?: string;
  sessionPath?: string;
  sessionRevision?: number;
};

export type SystemNotificationCandidate = {
  kind: SystemNotificationKind;
  target?: SystemNotificationTarget;
};

type SystemNotificationAttentionState = "foreground" | "background" | "unknown";

export type SystemNotificationObservationContext = {
  attention: SystemNotificationAttentionState;
  targetForSession: (sessionId: string, envelope: HostEventEnvelope) => SystemNotificationTarget;
};

type RunState = { failed: boolean; deliveredFailure: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminalAssistantOutcome(messages: unknown): "aborted" | "error" | "success" {
  if (!Array.isArray(messages)) return "success";
  const assistant = [...messages].reverse().find((message) => {
    return isRecord(message) && message.role === "assistant";
  });
  if (!isRecord(assistant)) return "success";
  if (assistant.stopReason === "aborted") return "aborted";
  if (assistant.stopReason === "error") return "error";
  return "success";
}

function runKey(event: HostEventEnvelope<"agent.event">): string {
  return [
    event.hostInstanceId,
    event.workspaceId ?? "",
    event.sessionId ?? "",
    event.payload.runId,
  ].join("/");
}

/** Stateful event classifier kept independent from notification delivery. */
export class SystemNotificationTracker {
  private readonly runs = new Map<string, RunState>();
  private readonly delivered = new Set<string>();
  private readonly deliveredAttention = new Set<string>();

  reset(): void {
    this.runs.clear();
    this.delivered.clear();
    this.deliveredAttention.clear();
  }

  observe(
    event: HostEventEnvelope,
    context: SystemNotificationObservationContext,
  ): SystemNotificationCandidate | null {
    const shouldNotify = context.attention === "background";

    if (event.event === "host.fatal") {
      if (!shouldNotify || this.deliveredAttention.has("host-fatal")) return null;
      this.deliveredAttention.add("host-fatal");
      return { kind: "host-fatal" };
    }

    if (event.event === "extensionUi.request" && event.sessionId) {
      const requestId =
        isRecord(event.payload) && typeof event.payload.requestId === "string"
          ? event.payload.requestId
          : `${event.hostInstanceId}/${event.sessionId}/${event.sequence}`;
      if (!shouldNotify || this.deliveredAttention.has(`input/${requestId}`)) return null;
      this.deliveredAttention.add(`input/${requestId}`);
      return {
        kind: "input-required",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (event.event !== "agent.event" || !event.sessionId) return null;

    const key = runKey(event);
    if (this.delivered.has(key)) return null;
    const state = this.runs.get(key) ?? { failed: false, deliveredFailure: false };
    const agentEvent = event.payload.event;

    if (agentEvent.type === "error") {
      state.failed = true;
      this.runs.set(key, state);
      if (state.deliveredFailure) return null;
      state.deliveredFailure = true;
      this.delivered.add(key);
      if (!shouldNotify) return null;
      return {
        kind: "session-failed",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (agentEvent.type === "agent_end") {
      if (agentEvent.willRetry === true) {
        this.runs.set(key, state);
        return null;
      }
      const outcome = terminalAssistantOutcome(agentEvent.messages);
      this.runs.delete(key);
      if (outcome === "aborted") return null;
      if (state.deliveredFailure) return null;
      this.delivered.add(key);
      if (!shouldNotify) return null;
      if (state.failed || outcome === "error") {
        return {
          kind: "session-failed",
          target: context.targetForSession(event.sessionId, event),
        };
      }
      return {
        kind: "response-ready",
        target: context.targetForSession(event.sessionId, event),
      };
    }

    if (agentEvent.type === "agent_settled") this.runs.delete(key);
    return null;
  }
}

export function systemNotificationCopy(kind: SystemNotificationKind): {
  title: string;
  body: string;
} {
  switch (kind) {
    case "response-ready":
      return {
        title: tCurrent("systemNotificationTitle"),
        body: tCurrent("systemNotificationReady"),
      };
    case "session-failed":
      return {
        title: tCurrent("systemNotificationTitle"),
        body: tCurrent("systemNotificationFailed"),
      };
    case "input-required":
      return {
        title: tCurrent("systemNotificationTitle"),
        body: tCurrent("systemNotificationInput"),
      };
    case "host-fatal":
      return {
        title: tCurrent("systemNotificationTitle"),
        body: tCurrent("systemNotificationHostUnavailable"),
      };
  }
}

type NotificationPayload = {
  kind: SystemNotificationKind;
  target?: SystemNotificationTarget;
};

function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (
    !(["response-ready", "session-failed", "input-required", "host-fatal"] as string[]).includes(
      value.kind,
    )
  ) {
    return false;
  }
  if (value.target === undefined) return true;
  if (!isRecord(value.target)) return false;
  return (
    (value.target.workspaceId === null || typeof value.target.workspaceId === "string") &&
    (value.target.workspaceRevision === undefined ||
      typeof value.target.workspaceRevision === "number")
  );
}

export type SystemNotificationControllerOptions = {
  enabled: () => boolean;
  attention: () => SystemNotificationAttentionState;
  targetForSession: (sessionId: string, envelope: HostEventEnvelope) => SystemNotificationTarget;
  openTarget: (target: SystemNotificationTarget) => Promise<void>;
};

export class SystemNotificationController {
  private readonly tracker = new SystemNotificationTracker();
  private readonly options: SystemNotificationControllerOptions;
  private permissionDenied = false;
  private disposed = false;
  private actionDisposer: (() => void) | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: SystemNotificationControllerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (!isTauri()) return;
    try {
      const api = await import("@tauri-apps/plugin-notification");
      const listener = await api.onAction((notification) => {
        const extra = notification.extra;
        if (!isNotificationPayload(extra)) return;
        void this.options.openTarget(
          extra.target ?? { workspaceId: null, workspaceRevision: undefined },
        );
      });
      if (this.disposed) {
        listener.unregister();
        return;
      }
      this.actionDisposer = () => listener.unregister();
    } catch {
      this.permissionDenied = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.actionDisposer?.();
    this.actionDisposer = null;
    this.tracker.reset();
  }

  reset(): void {
    this.tracker.reset();
  }

  observe(event: HostEventEnvelope): void {
    const candidate = this.tracker.observe(event, {
      attention: this.options.attention(),
      targetForSession: this.options.targetForSession,
    });
    if (!candidate || !this.options.enabled() || this.permissionDenied) return;
    this.sendQueue = this.sendQueue.then(() => this.send(candidate));
  }

  private async send(candidate: SystemNotificationCandidate): Promise<void> {
    if (this.options.attention() !== "background" || !this.options.enabled()) return;
    try {
      const api = await import("@tauri-apps/plugin-notification");
      let granted = await api.isPermissionGranted();
      if (!granted) {
        const permission = await api.requestPermission();
        granted = permission === "granted";
      }
      if (!granted) {
        this.permissionDenied = true;
        return;
      }
      const copy = systemNotificationCopy(candidate.kind);
      await api.sendNotification({
        title: copy.title,
        body: copy.body,
        autoCancel: true,
        extra: { kind: candidate.kind, ...(candidate.target ? { target: candidate.target } : {}) },
      });
    } catch {
      this.permissionDenied = true;
    }
  }
}
