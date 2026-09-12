import { createRequire } from "node:module";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiRequest, HostEventName, HostIdentity } from "@pideck/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInvocationContext } from "./extension-invocation-context.js";
import {
  cancelAllPending,
  createExtensionUiContext,
  respondExtensionUi,
} from "./extension-ui-bridge.js";

const require = createRequire(import.meta.url);
const OPTIONS = ["1. Alpha — First lane", "2. Beta — Second lane", "3. Type something."];

function harness(version: "v1" | "v2" | "v2-6" = "v2-6") {
  const identity: HostIdentity = {
    hostInstanceId: "host-questionnaire",
    workspaceId: "workspace-questionnaire",
    workspaceRevision: 1,
    sessionId: "session-questionnaire",
    sessionRevision: 1,
    packageRevision: 0,
  };
  const controller = new AbortController();
  const invocation: ExtensionInvocationContext = {
    session: {} as AgentSession,
    invocationId: "invocation-questionnaire",
    origin: {
      invocationKind: "tool",
      extensionId: "ext_questionnaire",
      extensionDisplayName: "Questionnaire",
      sourceKind: "package",
      toolName: "ask_user_question",
      toolCallId: "call-questionnaire",
    },
    sourceInfo: {
      path: require.resolve(`@pideck-test/rpiv-ask-user-question-${version}`),
      source: "extension fixture",
      scope: "temporary",
      origin: "top-level",
    },
    signal: controller.signal,
    active: true,
    widgetAttentionRequested: false,
  };
  const events: Array<{ event: HostEventName; payload: unknown }> = [];
  let disposed = false;
  const ui = createExtensionUiContext({
    emit: (event, payload) => events.push({ event, payload }),
    getIdentity: () => identity,
    getActiveInvocation: () => invocation,
    isDisposed: () => disposed,
  });
  return {
    ui,
    identity,
    invocation,
    controller,
    events,
    dispose: () => {
      disposed = true;
    },
    latestRequest: () =>
      events.filter((event) => event.event === "extensionUi.request").at(-1)!
        .payload as ExtensionUiRequest,
  };
}

afterEach(() => {
  cancelAllPending("questionnaire test cleanup");
  vi.useRealTimers();
});

describe("questionnaire input compatibility lifecycle", () => {
  it("leaves other published versions on standard select/input semantics", async () => {
    const fixture = harness("v1");
    const select = fixture.ui.select("Pick a lane", OPTIONS);
    const request = fixture.latestRequest();
    expect(request.customInputOptionId).toBeUndefined();
    expect(respondExtensionUi(request.requestId, "resolved", OPTIONS[2], fixture.identity)).toBe(
      true,
    );
    await expect(select).resolves.toBe(OPTIONS[2]);
    const input = fixture.ui.input("Type your answer");
    expect(fixture.latestRequest().kind).toBe("input");
    respondExtensionUi(fixture.latestRequest().requestId, "cancelled", undefined, fixture.identity);
    await expect(input).resolves.toBeUndefined();
  });

  it("does not infer custom entry from a label or malformed option sequence", async () => {
    const fixture = harness();
    for (const options of [
      ["Alpha", "Type something."],
      ["1. Alpha", "2. Type something."],
    ]) {
      const select = fixture.ui.select("An ordinary selector", options);
      expect(fixture.latestRequest().customInputOptionId).toBeUndefined();
      respondExtensionUi(
        fixture.latestRequest().requestId,
        "cancelled",
        undefined,
        fixture.identity,
      );
      await expect(select).resolves.toBeUndefined();
    }
  });

  it("consumes custom text only once and leaves the next input pending", async () => {
    const fixture = harness();
    const select = fixture.ui.select("Pick a lane", OPTIONS);
    const request = fixture.latestRequest();
    expect(request.customInputOptionId).toBe(OPTIONS[2]);
    respondExtensionUi(
      request.requestId,
      "resolved",
      { optionId: OPTIONS[2], input: "Custom lane" },
      fixture.identity,
    );
    await expect(select).resolves.toBe(OPTIONS[2]);
    await expect(fixture.ui.input("Type your answer")).resolves.toBe("Custom lane");
    expect(fixture.latestRequest().requestId).toBe(request.requestId);

    const next = fixture.ui.input("A separate question");
    expect(fixture.latestRequest().requestId).not.toBe(request.requestId);
    expect(fixture.latestRequest().kind).toBe("input");
    respondExtensionUi(
      fixture.latestRequest().requestId,
      "resolved",
      "Separate answer",
      fixture.identity,
    );
    await expect(next).resolves.toBe("Separate answer");
  });

  it.each(["abort", "dispose", "owner change"])(
    "discards buffered text after %s",
    async (action) => {
      const fixture = harness();
      const select = fixture.ui.select("Pick a lane", OPTIONS);
      const request = fixture.latestRequest();
      respondExtensionUi(
        request.requestId,
        "resolved",
        { optionId: OPTIONS[2], input: "Stale answer" },
        fixture.identity,
      );
      await select;
      if (action === "abort") fixture.controller.abort();
      else if (action === "dispose") fixture.dispose();
      else fixture.identity.sessionRevision += 1;

      await expect(fixture.ui.input("Type your answer")).resolves.toBeUndefined();
      expect(fixture.events.filter((event) => event.event === "extensionUi.request")).toHaveLength(
        1,
      );
    },
  );

  it("keeps the select timeout in force while Desktop edits custom text", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    const select = fixture.ui.select("Pick a lane", OPTIONS, { timeout: 100 });
    const request = fixture.latestRequest();
    expect(request.customInputOptionId).toBe(OPTIONS[2]);
    await vi.advanceTimersByTimeAsync(101);

    await expect(select).resolves.toBeUndefined();
    expect(fixture.events).toContainEqual({
      event: "extensionUi.closed",
      payload: { requestId: request.requestId, reason: "timed-out" },
    });
    expect(
      respondExtensionUi(
        request.requestId,
        "resolved",
        {
          optionId: OPTIONS[2],
          input: "Late text",
        },
        fixture.identity,
      ),
    ).toBe(false);
  });
});
