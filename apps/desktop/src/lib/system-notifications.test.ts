import { afterEach, describe, expect, it } from "vitest";
import type { HostEventEnvelope } from "@pideck/protocol";
import { useAppStore } from "./stores/app-store";
import {
  SystemNotificationTracker,
  systemNotificationCopy,
  type SystemNotificationTarget,
} from "./system-notifications";

const target: SystemNotificationTarget = {
  workspaceId: "workspace-1",
  workspaceRevision: 2,
  workspacePath: "/workspace",
  sessionId: "session-1",
  sessionPath: "/workspace/session.jsonl",
  sessionRevision: 4,
};

function event(
  eventName: HostEventEnvelope["event"],
  payload: unknown,
  overrides: Partial<HostEventEnvelope> = {},
): HostEventEnvelope {
  return {
    protocolVersion: 1,
    hostInstanceId: "host-1",
    workspaceId: "workspace-1",
    workspaceRevision: 2,
    sessionId: "session-1",
    sessionRevision: 4,
    packageRevision: 1,
    sequence: 1,
    timestamp: 1,
    event: eventName,
    payload,
    ...overrides,
  } as HostEventEnvelope;
}

function context(attention: "foreground" | "background" | "unknown" = "background") {
  return {
    attention,
    activeSessionId: null,
    targetForSession: () => target,
  };
}

describe("SystemNotificationTracker", () => {
  it("notifies for a background response once and suppresses foreground events", () => {
    const tracker = new SystemNotificationTracker();
    const response = event("agent.event", {
      runId: "run-1",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });
    const backgroundResponse = event("agent.event", {
      runId: "run-1-background",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(response, context("foreground"))).toBeNull();
    expect(tracker.observe(response, context())).toBeNull();
    expect(tracker.observe(backgroundResponse, context())).toMatchObject({
      kind: "response-ready",
      target,
    });
  });

  it("waits through retries and suppresses aborted responses", () => {
    const tracker = new SystemNotificationTracker();
    const retry = event("agent.event", {
      runId: "run-2",
      event: { type: "agent_end", willRetry: true, messages: [] },
    });
    const final = event("agent.event", {
      runId: "run-2",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });
    const aborted = event("agent.event", {
      runId: "run-3",
      event: {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
    });

    expect(tracker.observe(retry, context())).toBeNull();
    expect(tracker.observe(final, context())).toMatchObject({ kind: "response-ready" });
    expect(tracker.observe(aborted, context())).toBeNull();
  });

  it("does not duplicate a failure reported before agent_end", () => {
    const tracker = new SystemNotificationTracker();
    const failure = event("agent.event", {
      runId: "run-4",
      event: { type: "error", message: "x" },
    });
    const end = event("agent.event", {
      runId: "run-4",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(failure, context())).toMatchObject({ kind: "session-failed" });
    expect(tracker.observe(end, context())).toBeNull();
  });

  it("does not replay a foreground failure after the session moves to background", () => {
    const tracker = new SystemNotificationTracker();
    const failure = event("agent.event", {
      runId: "run-foreground-error",
      event: { type: "error" },
    });
    const end = event("agent.event", {
      runId: "run-foreground-error",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(failure, context("foreground"))).toBeNull();
    expect(tracker.observe(end, context())).toBeNull();
  });

  it("notifies for input-required and Host fatal attention", () => {
    const tracker = new SystemNotificationTracker();
    expect(
      tracker.observe(
        event("extensionUi.request", { requestId: "request-1", kind: "confirm" }),
        context(),
      ),
    ).toMatchObject({ kind: "input-required", target });
    expect(tracker.observe(event("host.fatal", { error: { message: "down" } }), context())).toEqual(
      {
        kind: "host-fatal",
      },
    );
  });
});

describe("systemNotificationCopy", () => {
  afterEach(() => useAppStore.getState().setDesktopSettings(null));

  it.each([
    ["en", "A response is ready"],
    ["zh", "有新的回复"],
  ] as const)("uses the %s locale", (language, body) => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language,
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    });
    expect(systemNotificationCopy("response-ready")).toEqual({ title: "PiDeck", body });
  });
});
