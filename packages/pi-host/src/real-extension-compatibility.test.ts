import { createRequire } from "node:module";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  wrapRegisteredTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindExtensionUi,
  cancelAllPending,
  respondExtensionUi,
  type ExtensionUiBinding,
} from "./extension-ui-bridge.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

const require = createRequire(import.meta.url);
const RPIV_V1_ENTRYPOINT = require.resolve("@pideck-test/rpiv-ask-user-question-v1");
const RPIV_V2_ENTRYPOINT = require.resolve("@pideck-test/rpiv-ask-user-question-v2");
const RPIV_V2_6_ENTRYPOINT = require.resolve("@pideck-test/rpiv-ask-user-question-v2-6");

type EmittedEvent = { event: HostEventName; payload: unknown };

type DecisionPayload = {
  requestId: string;
  kind: string;
  title?: string;
  message?: string;
  options?: Array<{ id: string; label: string }>;
  origin: {
    invocationKind: string;
    extensionId: string;
    toolName?: string;
    toolCallId?: string;
  };
  presentation: string;
  routeReason: string;
  groupKey?: string;
  customInputOptionId?: string;
};

type LoadedExtension = {
  binding: ExtensionUiBinding;
  events: EmittedEvent[];
  identity: HostIdentity;
  layout: TempAgentLayout;
  promptEvents: unknown[];
  blockedEvents: unknown[];
  session: AgentSession;
  cleanup: () => void;
};

function identity(sessionId: string): HostIdentity {
  return {
    hostInstanceId: "host-real-extension",
    workspaceId: "workspace-real-extension",
    workspaceRevision: 1,
    sessionId,
    sessionRevision: 1,
    packageRevision: 0,
  };
}

async function loadPublishedExtension(
  entrypoint: string,
  sessionId: string,
): Promise<LoadedExtension> {
  const layout = createTempAgentLayout("pideck-real-extension-");
  const eventBus = createEventBus();
  const promptEvents: unknown[] = [];
  const blockedEvents: unknown[] = [];
  eventBus.on("rpiv:ask-user:prompt", (payload) => promptEvents.push(payload));
  eventBus.on("rpiv:ask-user:blocked", (payload) => blockedEvents.push(payload));

  const settingsManager = SettingsManager.create(layout.projectDir, layout.agentDir, {
    projectTrusted: true,
  });
  const { modelRuntime } = await createTestModelServices(layout.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: layout.projectDir,
    agentDir: layout.agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [entrypoint],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: layout.projectDir,
    agentDir: layout.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });

  const events: EmittedEvent[] = [];
  const owner = identity(sessionId);
  const binding = await bindExtensionUi(session, null, {
    emit: (event, payload) => events.push({ event, payload }),
    getIdentity: () => owner,
    getCurrentIdentity: () => owner,
    getExtensionDecisionPresentation: () => "auto",
    isInlineSurfaceAvailable: () => true,
  });
  const publish = await binding.activate();
  publish();

  return {
    binding,
    events,
    identity: owner,
    layout,
    promptEvents,
    blockedEvents,
    session,
    cleanup: () => {
      binding.cleanup();
      session.dispose();
      eventBus.clear();
      layout.cleanup();
    },
  };
}

async function waitForEvent<T>(
  events: EmittedEvent[],
  eventName: HostEventName,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = events.find(
      (event) => event.event === eventName && predicate(event.payload as T),
    );
    if (match) return match.payload as T;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

function registeredAskUserTool(session: AgentSession) {
  const registered = session.extensionRunner
    .getAllRegisteredTools()
    .find((tool) => tool.definition.name === "ask_user_question");
  expect(registered).toBeDefined();
  return wrapRegisteredTool(registered!, session.extensionRunner);
}

const QUESTIONNAIRE = {
  questions: [
    {
      question: "When should this ship?",
      header: "Release",
      options: [
        { label: "Ship now", description: "Release the current build." },
        { label: "Wait", description: "Collect more evidence first." },
      ],
    },
    {
      question: "What else should be included?",
      header: "Scope",
      options: [
        { label: "Metrics", description: "Add operational metrics." },
        { label: "Docs", description: "Expand the operator guide." },
      ],
    },
  ],
};

afterEach(() => {
  cancelAllPending("real extension compatibility cleanup");
});

describe.each([
  ["2.1.0", RPIV_V2_ENTRYPOINT],
  ["2.6.1", RPIV_V2_6_ENTRYPOINT],
])("pinned rpiv %s RPC compatibility", (_version, entrypoint) => {
  it("runs the pinned rpiv v2 package through native RPC decisions", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2");
    try {
      const tool = registeredAskUserTool(loaded.session);
      const running = tool.execute("tool-call-rpiv-v2", QUESTIONNAIRE, undefined, undefined);

      const first = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.kind === "select",
      );
      expect(first).toMatchObject({
        kind: "select",
        presentation: "inline",
        routeReason: "active-tool",
        origin: {
          invocationKind: "tool",
          toolName: "ask_user_question",
          toolCallId: "tool-call-rpiv-v2",
        },
      });
      expect(first.origin.extensionId).toMatch(/^ext_[0-9a-f]{24}$/);
      expect(first.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
      expect(loaded.promptEvents).toEqual([
        expect.objectContaining({
          questions: expect.arrayContaining([
            expect.objectContaining({ question: "When should this ship?" }),
            expect.objectContaining({ question: "What else should be included?" }),
          ]),
        }),
      ]);
      const shipNowOption = first.options?.find((option) => option.label.includes("Ship now"));
      expect(shipNowOption).toBeDefined();
      expect(
        respondExtensionUi(first.requestId, "resolved", shipNowOption!.id, loaded.identity),
      ).toBe(true);

      const second = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.requestId !== first.requestId && payload.kind === "select",
      );
      expect(second.groupKey).toBe(first.groupKey);
      const customOption = second.options?.find((option) =>
        option.label.includes("Type something"),
      );
      expect(customOption).toBeDefined();
      expect(
        respondExtensionUi(second.requestId, "resolved", customOption!.id, loaded.identity),
      ).toBe(true);

      const third = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.kind === "input",
      );
      expect(third.groupKey).toBe(first.groupKey);
      expect(
        respondExtensionUi(third.requestId, "resolved", "Add audit logging", loaded.identity),
      ).toBe(true);

      await expect(running).resolves.toMatchObject({
        details: {
          cancelled: false,
          answers: [
            expect.objectContaining({
              question: "When should this ship?",
              answer: "Ship now",
            }),
            expect.objectContaining({
              question: "What else should be included?",
              answer: "Add audit logging",
            }),
          ],
        },
      });
      expect(loaded.blockedEvents).toEqual([{ active: true }, { active: false }]);
      expect(loaded.events.filter((event) => event.event === "extensionUi.groupClosed")).toEqual([
        {
          event: "extensionUi.groupClosed",
          payload: { groupKey: first.groupKey, status: "completed" },
        },
      ]);
      expect(loaded.events.some((event) => event.event === "extensionUi.customStarted")).toBe(
        false,
      );
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it("preserves partial structured answers when the pinned rpiv v2 questionnaire is cancelled", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2-cancel");
    try {
      const running = registeredAskUserTool(loaded.session).execute(
        "tool-call-rpiv-v2-cancel",
        QUESTIONNAIRE,
        undefined,
        undefined,
      );
      const first = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.origin.toolCallId === "tool-call-rpiv-v2-cancel",
      );
      const shipNowOption = first.options?.find((option) => option.label.includes("Ship now"));
      expect(shipNowOption).toBeDefined();
      expect(
        respondExtensionUi(first.requestId, "resolved", shipNowOption!.id, loaded.identity),
      ).toBe(true);

      const second = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) =>
          payload.origin.toolCallId === "tool-call-rpiv-v2-cancel" &&
          payload.requestId !== first.requestId,
      );
      expect(second.groupKey).toBe(first.groupKey);
      expect(respondExtensionUi(second.requestId, "cancelled", undefined, loaded.identity)).toBe(
        true,
      );

      await expect(running).resolves.toMatchObject({
        content: [{ type: "text", text: "User declined to answer questions" }],
        details: {
          cancelled: true,
          answers: [
            expect.objectContaining({
              question: "When should this ship?",
              answer: "Ship now",
            }),
          ],
        },
      });
      expect(loaded.blockedEvents).toEqual([{ active: true }, { active: false }]);
      expect(respondExtensionUi(second.requestId, "resolved", "late", loaded.identity)).toBe(false);
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it("submits native custom entry as one question while retaining option answers and previews", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2-custom");
    try {
      const preview = "## Release preview\nShip the current version.";
      const running = registeredAskUserTool(loaded.session).execute(
        "tool-call-rpiv-v2-custom",
        {
          questions: [
            {
              ...QUESTIONNAIRE.questions[0],
              options: QUESTIONNAIRE.questions[0]!.options.map((option, index) =>
                index === 0 ? { ...option, preview } : option,
              ),
            },
            QUESTIONNAIRE.questions[1],
          ],
        },
        undefined,
        undefined,
      );
      const first = await waitForEvent<DecisionPayload>(loaded.events, "extensionUi.request");
      expect(first.customInputOptionId).toBe(first.options?.at(-1)?.id);
      expect(
        respondExtensionUi(first.requestId, "resolved", first.options![0]!.id, loaded.identity),
      ).toBe(true);
      const second = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.requestId !== first.requestId,
      );
      expect(second.customInputOptionId).toBe(second.options?.at(-1)?.id);
      expect(second.groupKey).toBe(first.groupKey);
      const customAnswer = { optionId: second.customInputOptionId!, input: "Add audit logging" };
      expect(
        respondExtensionUi(second.requestId, "resolved", customAnswer, {
          ...loaded.identity,
          sessionId: "different-session",
        }),
      ).toBe(false);
      for (const invalid of [
        { ...customAnswer, optionId: second.options![0]!.id },
        { ...customAnswer, input: 42 },
        { ...customAnswer, extra: true },
        { input: "Missing option" },
      ]) {
        expect(respondExtensionUi(second.requestId, "resolved", invalid, loaded.identity)).toBe(
          false,
        );
      }
      expect(respondExtensionUi(second.requestId, "resolved", customAnswer, loaded.identity)).toBe(
        true,
      );
      expect(respondExtensionUi(second.requestId, "resolved", customAnswer, loaded.identity)).toBe(
        false,
      );

      await expect(running).resolves.toMatchObject({
        details: {
          cancelled: false,
          answers: [
            { questionIndex: 0, kind: "option", answer: "Ship now", preview },
            { questionIndex: 1, kind: "custom", answer: "Add audit logging" },
          ],
        },
      });
      expect(loaded.events.filter((event) => event.event === "extensionUi.request")).toHaveLength(
        2,
      );
      expect(loaded.blockedEvents).toEqual([{ active: true }, { active: false }]);
      expect(loaded.events.filter((event) => event.event === "extensionUi.groupClosed")).toEqual([
        {
          event: "extensionUi.groupClosed",
          payload: { groupKey: first.groupKey, status: "completed" },
        },
      ]);
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it("runs the pinned rpiv v2 numeric multi-select fallback through native input", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2-multi");
    try {
      const running = registeredAskUserTool(loaded.session).execute(
        "tool-call-rpiv-v2-multi",
        {
          questions: [
            {
              question: "Which safeguards should be enabled?",
              header: "Safety",
              multiSelect: true,
              options: [
                { label: "Audit log", description: "Record every decision." },
                { label: "Approval gate", description: "Require explicit approval." },
                { label: "Dry run", description: "Preview changes first." },
              ],
            },
          ],
        },
        undefined,
        undefined,
      );
      const request = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.origin.toolCallId === "tool-call-rpiv-v2-multi",
      );

      expect(request).toMatchObject({
        kind: "input",
        message: "1,3",
        origin: {
          invocationKind: "tool",
          toolName: "ask_user_question",
          toolCallId: "tool-call-rpiv-v2-multi",
        },
      });
      expect(loaded.promptEvents).toEqual([
        expect.objectContaining({
          questions: [expect.objectContaining({ multiSelect: true })],
        }),
      ]);
      expect(respondExtensionUi(request.requestId, "resolved", "1,2", loaded.identity)).toBe(true);

      await expect(running).resolves.toMatchObject({
        details: {
          cancelled: false,
          answers: [
            expect.objectContaining({
              kind: "multi",
              answer: null,
              selected: ["Audit log", "Approval gate"],
            }),
          ],
        },
      });
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it("closes the pinned rpiv v2 decision when its tool signal aborts", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2-abort");
    try {
      const controller = new AbortController();
      const running = registeredAskUserTool(loaded.session).execute(
        "tool-call-rpiv-v2-abort",
        { questions: [QUESTIONNAIRE.questions[0]] },
        controller.signal,
        undefined,
      );
      const request = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.origin.toolCallId === "tool-call-rpiv-v2-abort",
      );

      controller.abort();

      const closed = await waitForEvent<{ requestId: string; reason: string }>(
        loaded.events,
        "extensionUi.closed",
        (payload) => payload.requestId === request.requestId,
      );
      expect(closed).toEqual({ requestId: request.requestId, reason: "aborted" });
      await expect(running).resolves.toMatchObject({
        details: { answers: [], cancelled: true },
      });
      expect(loaded.blockedEvents).toEqual([{ active: true }, { active: false }]);
      expect(respondExtensionUi(request.requestId, "resolved", "late", loaded.identity)).toBe(
        false,
      );
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it("isolates parallel pinned rpiv v2 prompts and accepts out-of-order responses", async () => {
    const loaded = await loadPublishedExtension(entrypoint, "session-rpiv-v2-parallel");
    try {
      const tool = registeredAskUserTool(loaded.session);
      const firstRun = tool.execute(
        "tool-call-rpiv-v2-parallel-a",
        {
          questions: [
            {
              question: "Choose the first rollout lane?",
              header: "Lane A",
              options: [
                { label: "Alpha", description: "Use the alpha lane." },
                { label: "Beta", description: "Use the beta lane." },
              ],
            },
          ],
        },
        undefined,
        undefined,
      );
      const secondRun = tool.execute(
        "tool-call-rpiv-v2-parallel-b",
        {
          questions: [
            {
              question: "Choose the second rollout lane?",
              header: "Lane B",
              options: [
                { label: "Canary", description: "Use the canary lane." },
                { label: "Stable", description: "Use the stable lane." },
              ],
            },
          ],
        },
        undefined,
        undefined,
      );
      const first = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.origin.toolCallId === "tool-call-rpiv-v2-parallel-a",
      );
      const second = await waitForEvent<DecisionPayload>(
        loaded.events,
        "extensionUi.request",
        (payload) => payload.origin.toolCallId === "tool-call-rpiv-v2-parallel-b",
      );

      expect(first.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
      expect(second.groupKey).toMatch(/^tool:[0-9a-f]{32}$/);
      expect(second.groupKey).not.toBe(first.groupKey);
      expect(first.customInputOptionId).toBeDefined();
      expect(second.customInputOptionId).toBeDefined();
      expect(
        respondExtensionUi(
          second.requestId,
          "resolved",
          { optionId: second.customInputOptionId, input: "Lane B custom answer" },
          loaded.identity,
        ),
      ).toBe(true);
      expect(
        respondExtensionUi(
          first.requestId,
          "resolved",
          { optionId: first.customInputOptionId, input: "Lane A custom answer" },
          loaded.identity,
        ),
      ).toBe(true);

      await expect(secondRun).resolves.toMatchObject({
        details: {
          answers: [expect.objectContaining({ kind: "custom", answer: "Lane B custom answer" })],
        },
      });
      await expect(firstRun).resolves.toMatchObject({
        details: {
          answers: [expect.objectContaining({ kind: "custom", answer: "Lane A custom answer" })],
        },
      });
      const closedGroups = loaded.events
        .filter((event) => event.event === "extensionUi.groupClosed")
        .map((event) => event.payload as { groupKey: string; status: string });
      expect(closedGroups).toEqual(
        expect.arrayContaining([
          { groupKey: first.groupKey!, status: "completed" },
          { groupKey: second.groupKey!, status: "completed" },
        ]),
      );
    } finally {
      loaded.cleanup();
    }
  }, 30_000);
});

describe("pinned rpiv v1 custom terminal compatibility", () => {
  it("keeps the pinned rpiv v1 package on the custom terminal fallback", async () => {
    const loaded = await loadPublishedExtension(RPIV_V1_ENTRYPOINT, "session-rpiv-v1");
    try {
      const tool = registeredAskUserTool(loaded.session);
      const running = tool.execute(
        "tool-call-rpiv-v1",
        { questions: [QUESTIONNAIRE.questions[0]] },
        undefined,
        undefined,
      );
      const started = await waitForEvent<{ requestId: string }>(
        loaded.events,
        "extensionUi.customStarted",
      );

      expect(loaded.promptEvents).toEqual([
        expect.objectContaining({
          questions: [expect.objectContaining({ question: "When should this ship?" })],
        }),
      ]);
      expect(loaded.events.some((event) => event.event === "extensionUi.request")).toBe(false);
      expect(respondExtensionUi(started.requestId, "cancelled", undefined, loaded.identity)).toBe(
        true,
      );
      await expect(running).resolves.toMatchObject({
        details: { answers: [], cancelled: true },
      });
      expect(loaded.events.filter((event) => event.event === "extensionUi.customClosed")).toEqual([
        {
          event: "extensionUi.customClosed",
          payload: { requestId: started.requestId },
        },
      ]);
    } finally {
      loaded.cleanup();
    }
  }, 30_000);
});
