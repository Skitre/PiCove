/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseHostRequest,
  type HostError,
  type HostEventName,
  type HostEventPayloadMap,
  type HostRequestEnvelope,
  type HostStatusSnapshot,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from "@pideck/protocol";
import { handleHostEvent } from "../../app/App";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { ExtensionUiModal } from "./ExtensionUiModal";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";

const CONTEXT = {
  expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
  expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
  expectedWorkspaceRevision: 1,
  expectedSessionId: "33333333-3333-4333-8333-333333333333",
  expectedSessionRevision: 1,
};

function hostSnapshot(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: CONTEXT.expectedHostInstanceId,
    workspaceId: CONTEXT.expectedWorkspaceId,
    workspaceRevision: CONTEXT.expectedWorkspaceRevision,
    sessionId: CONTEXT.expectedSessionId,
    sessionRevision: CONTEXT.expectedSessionRevision,
    packageRevision: 0,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    id: CONTEXT.expectedWorkspaceId,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: CONTEXT.expectedWorkspaceRevision,
    servicesReady: true,
  };
}

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: CONTEXT.expectedSessionId,
    cwd: "/workspace",
    revision: CONTEXT.expectedSessionRevision,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "Existing conversation" }],
    tools: {
      revision: 1,
      workspaceId: CONTEXT.expectedWorkspaceId,
      sessionId: CONTEXT.expectedSessionId,
      sessionRevision: CONTEXT.expectedSessionRevision,
      tools: [],
      active: [],
    },
  };
}

let requestSequence = 0;

function setLanguage(language: "en" | "zh") {
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language,
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
}

function extensionRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  requestSequence += 1;
  return {
    requestId: `44444444-4444-4444-8444-${String(requestSequence).padStart(12, "0")}`,
    kind: "confirm",
    title: "Choose how to continue",
    context: CONTEXT,
    ...overrides,
  };
}

function renderRequestSurfaces() {
  return render(
    <>
      <InlineExtensionUiRequest />
      <ExtensionUiModal />
    </>,
  );
}

function questionnaireRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  return extensionRequest({
    kind: "select",
    title: "Choose a release lane",
    options: [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "other", label: "Type something…" },
    ],
    customInputOptionId: "other",
    ...overrides,
  });
}

function questionnaireTransport() {
  const sent: HostRequestEnvelope<"extensionUi.respond">[] = [];
  let deliver: (line: string) => void = () => {};
  let sequence = 0;
  const identity = {
    hostInstanceId: CONTEXT.expectedHostInstanceId,
    workspaceId: CONTEXT.expectedWorkspaceId,
    workspaceRevision: CONTEXT.expectedWorkspaceRevision,
    sessionId: CONTEXT.expectedSessionId,
    sessionRevision: CONTEXT.expectedSessionRevision,
    packageRevision: 0,
  };
  const requestRecovery = vi.fn();
  const agentEventBuffer = { enqueue: vi.fn(), flush: vi.fn() };
  hostClient.attach({
    send(line) {
      const parsed = parseHostRequest(JSON.parse(line));
      if (!parsed.ok) throw new Error(parsed.error.message);
      if (parsed.value.method !== "extensionUi.respond") throw new Error("Unexpected RPC");
      sent.push(parsed.value as HostRequestEnvelope<"extensionUi.respond">);
    },
    onMessage(handler) {
      deliver = handler;
      return () => {
        deliver = () => {};
      };
    },
  });
  const unsubscribe = hostClient.onEvent((event) =>
    handleHostEvent(event, requestRecovery, agentEventBuffer),
  );
  function emit<N extends HostEventName>(event: N, payload: HostEventPayloadMap[N]) {
    act(() =>
      deliver(
        JSON.stringify({
          protocolVersion: 1,
          ...identity,
          event,
          payload,
          sequence: ++sequence,
          timestamp: Date.now(),
        }),
      ),
    );
  }
  useAppStore.setState({
    host: null,
    workspace: null,
    session: null,
    lastSequence: 0,
    desynchronized: false,
    rehydrating: false,
  });
  emit("host.ready", hostSnapshot());
  act(() => {
    useAppStore.getState().applyWorkspaceSnapshot(workspaceSnapshot());
    useAppStore.getState().applySessionSnapshot(sessionSnapshot());
    useAppStore.setState({ desynchronized: false, rehydrating: false });
  });
  return {
    sent,
    emit,
    publish(request: ExtensionUiRequestState) {
      const { context: _context, expiresAt: _expiresAt, ...payload } = request;
      emit("extensionUi.request", payload);
    },
    async reply(index: number, error?: HostError) {
      const request = sent[index]!;
      await act(async () =>
        deliver(
          JSON.stringify({
            protocolVersion: 1,
            ...identity,
            id: request.id,
            method: request.method,
            ...(error ? { ok: false, error } : { ok: true, result: { accepted: true } }),
          }),
        ),
      );
    },
    dispose() {
      unsubscribe();
      hostClient.detach("questionnaire test cleanup");
      expect(requestRecovery).not.toHaveBeenCalled();
    },
  };
}

beforeEach(() => {
  requestSequence = 0;
  setLanguage("en");
  useAppStore.setState({ notifications: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setDesktopSettings(null);
});

describe.each(["inline", "modal"] as const)("%s questionnaire JSONL transport", (presentation) => {
  let wire: ReturnType<typeof questionnaireTransport>;
  beforeEach(() => {
    wire = questionnaireTransport();
  });
  afterEach(() => {
    wire.dispose();
  });

  it("advances through real event delivery and cancels after the next question arrives before acknowledgement", async () => {
    const first = questionnaireRequest({ presentation, groupKey: "tool:transport" });
    wire.publish(first);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <InlineExtensionUiRequest />
        <ExtensionUiModal />
      </StrictMode>,
    );

    await user.click(screen.getByRole("button", { name: "Alpha" }));
    expect(wire.sent[0]?.params).toEqual({
      requestId: first.requestId,
      status: "resolved",
      value: "alpha",
    });
    const next = questionnaireRequest({
      presentation,
      groupKey: first.groupKey,
      title: "Next question",
    });
    wire.publish(next);
    await wire.reply(0);
    expect(screen.getByRole("heading", { name: "Next question" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Type something…" }));
    await user.type(screen.getByRole("textbox", { name: "Your response" }), "A draft{Escape}");
    expect(wire.sent).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(wire.sent[1]?.params).toEqual({ requestId: next.requestId, status: "cancelled" });
    wire.emit("extensionUi.groupClosed", { groupKey: first.groupKey!, status: "cancelled" });
    await wire.reply(1);
    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionDecisionGroups).toEqual({});
    expect(screen.queryByRole("heading", { name: "Next question" })).not.toBeInTheDocument();
  });

  it("removes an ended question and releases its group even when close events were missed", async () => {
    const request = questionnaireRequest({ presentation, groupKey: "tool:ended" });
    wire.publish(request);
    const user = userEvent.setup();
    renderRequestSurfaces();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await wire.reply(0, {
      code: "STALE_REVISION",
      message: "Unknown, expired, or stale Extension UI requestId",
      retryable: false,
      details: { requestId: request.requestId, requestClosed: true },
    });
    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionDecisionGroups).toEqual({});
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications.at(-1)?.message).toBe(
      "This Extension question is no longer active.",
    );
  });

  it("keeps a live question retryable when the response fails its identity check", async () => {
    const request = questionnaireRequest({ presentation, groupKey: "tool:live" });
    wire.publish(request);
    const user = userEvent.setup();
    renderRequestSurfaces();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await wire.reply(0, {
      code: "STALE_REVISION",
      message: "Session identity changed",
      retryable: false,
      details: { requestId: request.requestId, requestClosed: false },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Session identity changed");
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(request.requestId);
    expect(useAppStore.getState().extensionDecisionGroups[request.groupKey!]?.status).toBe(
      "active",
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await wire.reply(1);
  });

  it("does not close a newer question in the same group after a late stale response", async () => {
    const first = questionnaireRequest({ presentation, groupKey: "tool:late-response" });
    wire.publish(first);
    const user = userEvent.setup();
    renderRequestSurfaces();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    const next = questionnaireRequest({
      presentation,
      groupKey: first.groupKey,
      title: "Question still active",
    });
    wire.publish(next);
    await wire.reply(0, {
      code: "STALE_REVISION",
      message: "Unknown, expired, or stale Extension UI requestId",
      retryable: false,
      details: { requestId: first.requestId, requestClosed: true },
    });
    expect(screen.getByRole("heading", { name: next.title })).toBeVisible();
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(next.requestId);
    expect(useAppStore.getState().extensionDecisionGroups[first.groupKey!]?.status).toBe("active");
    await user.click(screen.getByRole("button", { name: "Close" }));
    wire.emit("extensionUi.groupClosed", { groupKey: first.groupKey!, status: "cancelled" });
    await wire.reply(1);
  });
});
