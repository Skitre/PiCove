import { describe, expect, it } from "vitest";
import { validateSuccessResult } from "@pideck/protocol";
import type { HandlerContext } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import { createSessionHandlers } from "./session-controller.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

describe("session.list runtime metadata", () => {
  it("includes the active and retained background Runtime states", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const runtimes = new Map([
      [ACTIVE_SESSION_ID, { runtimeState: "idle" as const, sessionRevision: 5 }],
      [BACKGROUND_SESSION_ID, { runtimeState: "running" as const, sessionRevision: 3 }],
    ]);
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({ workspaceId: WORKSPACE_ID }),
      listSessions: async () => [
        {
          id: ACTIVE_SESSION_ID,
          path: "C:/sessions/active.jsonl",
          name: "Active",
          cwd: "C:/workspace",
          modified: new Date(10),
          messageCount: 2,
        },
        {
          id: BACKGROUND_SESSION_ID,
          path: "C:/sessions/background.jsonl",
          firstMessage: "历史会话的首条消息",
          cwd: "C:/workspace",
          modified: new Date(20),
          messageCount: 4,
        },
      ],
      getSessionRuntimeInfo: (sessionId: string) => runtimes.get(sessionId) ?? null,
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.list"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.list",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(validateSuccessResult("session.list", response.result).ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: WORKSPACE_ID,
      items: [
        expect.objectContaining({
          sessionId: ACTIVE_SESSION_ID,
          runtimeState: "idle",
          sessionRevision: 5,
        }),
        expect.objectContaining({
          sessionId: BACKGROUND_SESSION_ID,
          name: undefined,
          firstMessage: "历史会话的首条消息",
          runtimeState: "running",
          sessionRevision: 3,
        }),
      ],
    });
  });
});

describe("session.getTree", () => {
  it("emits wire-valid nodes even when SDK labels are undefined-keyed", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        sessionManager: {
          // Mirrors SDK getTree(): unlabeled nodes still carry the keys.
          getTree: () => [
            {
              entry: {
                id: "u1",
                type: "message",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "user", content: "first ask" },
              },
              children: [
                {
                  entry: {
                    id: "a1",
                    type: "message",
                    parentId: "u1",
                    timestamp: "2026-01-01T00:00:02.000Z",
                    message: { role: "assistant", content: [] },
                  },
                  children: [],
                  label: "experiment",
                  labelTimestamp: "2026-01-01T00:00:03.000Z",
                },
              ],
              label: undefined,
              labelTimestamp: undefined,
            },
          ],
          getLeafId: () => "a1",
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getTree"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getTree",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(validateSuccessResult("session.getTree", response.result)).toMatchObject({
      ok: true,
    });
    const tree = (response.result as { tree: Record<string, unknown>[] }).tree;
    expect("label" in tree[0]!).toBe(false);
    expect("labelTimestamp" in tree[0]!).toBe(false);
    expect((tree[0]!.children as Record<string, unknown>[])[0]!.label).toBe("experiment");
  });
});

describe("session.export", () => {
  function exportFixture(isIdle: boolean) {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const agentSession = {
      isIdle,
      exportToHtml: async (path?: string) => path ?? "/exports/default.html",
      exportToJsonl: (path?: string) => path ?? "/exports/default.jsonl",
    };
    const factory = {
      getServer: () => ({ identity, serviceGraphLock: new TryMutex() }),
      checkIdentity: () => null,
      getGraph: () => ({ agentSession }),
      getSessionOperationLock: () => ({ isHeld: () => false }),
    } as unknown as WorkspaceGraphFactory;
    return factory;
  }

  it("exports html and jsonl to the requested path", async () => {
    const handler = createSessionHandlers(exportFixture(true))["session.export"]!;

    const html = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.export",
      params: { format: "html", path: "/tmp/out.html" },
      context: {},
    } as HandlerContext);
    expect(html).toEqual({ result: { path: "/tmp/out.html" } });

    const jsonl = await handler({
      id: "55555555-5555-4555-8555-555555555556",
      method: "session.export",
      params: { format: "jsonl" },
      context: {},
    } as HandlerContext);
    expect(jsonl).toEqual({ result: { path: "/exports/default.jsonl" } });
  });

  it("rejects while the agent is busy", async () => {
    const handler = createSessionHandlers(exportFixture(false))["session.export"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.export",
      params: { format: "html" },
      context: {},
    } as HandlerContext);

    expect("error" in response && response.error.code).toBe("AGENT_BUSY");
  });
});

describe("session.getForkPoints", () => {
  it("lists the session's user messages for the fork selector", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        agentSession: {
          getUserMessagesForForking: () => [
            { entryId: "u1", text: "first ask" },
            { entryId: "u2", text: "second ask" },
          ],
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getForkPoints"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getForkPoints",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      items: [
        { entryId: "u1", text: "first ask" },
        { entryId: "u2", text: "second ask" },
      ],
    });
  });
});

describe("session.getStats", () => {
  it("maps AgentSession.getSessionStats into the protocol snapshot", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        agentSession: {
          getSessionStats: () => ({
            sessionFile: "/sessions/active.jsonl",
            sessionId: ACTIVE_SESSION_ID,
            userMessages: 4,
            assistantMessages: 5,
            toolCalls: 7,
            toolResults: 7,
            totalMessages: 16,
            tokens: {
              input: 1200,
              output: 300,
              cacheRead: 8000,
              cacheWrite: 900,
              total: 10400,
            },
            cost: 0.42,
          }),
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getStats"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getStats",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      messageCount: 16,
      toolCallCount: 7,
      userMessageCount: 4,
      assistantMessageCount: 5,
      toolResultCount: 7,
      tokens: {
        input: 1200,
        output: 300,
        cacheRead: 8000,
        cacheWrite: 900,
        total: 10400,
      },
      cost: 0.42,
      sessionFile: "/sessions/active.jsonl",
    });
  });
});
