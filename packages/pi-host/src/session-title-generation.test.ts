import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import { PIDECK_NO_MODEL } from "./no-model.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import type { PiHostServer } from "./server.js";
import { generateRefinedSessionTitle } from "./session-title.js";
import {
  WorkspaceGraphFactory,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";

vi.mock("./session-title.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-title.js")>()),
  generateRefinedSessionTitle: vi.fn(),
}));

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SELECTED_MODEL = {
  provider: "selected-provider",
  id: "selected-model",
  api: "openai-completions",
} as NonNullable<AgentSession["model"]>;
const roots: string[] = [];
const generate = vi.mocked(generateRefinedSessionTitle);

beforeEach(() => {
  generate.mockReset().mockResolvedValue("Generated title");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withMessages = true) {
  const root = mkdtempSync(join(tmpdir(), "pideck-manual-title-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = resolve(root, "workspace");
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${SESSION_ID}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const records: unknown[] = [
    { type: "session", version: 3, id: SESSION_ID, timestamp, cwd },
    { type: "session_info", id: "info", parentId: null, timestamp, name: "Original title" },
  ];
  if (withMessages)
    records.push(
      {
        type: "message",
        id: "user",
        parentId: "info",
        timestamp,
        message: { role: "user", content: "Repair the target conversation", timestamp: 1 },
      },
      {
        type: "message",
        id: "answer",
        parentId: "user",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The target conversation is repaired." }],
          api: "openai-completions",
          provider: "old-provider",
          model: "old-model",
          stopReason: "stop",
          timestamp: 2,
        },
      },
    );
  writeFileSync(sessionPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const factory = new WorkspaceGraphFactory({ agentDir, modelRegistry: {} } as GraphFactoryDeps);
  const graph = {
    workspaceId: "workspace-1",
    canonicalCwd: cwd,
    servicesReady: true,
    agentSession: { model: SELECTED_MODEL, isIdle: true },
    sessionManager: null,
    sessionSnapshot: null,
    backgroundSessions: new Map(),
  } as unknown as WorkspaceGraph;
  factory.graph = graph;
  const identity = new IdentityState();
  identity.workspaceId = graph.workspaceId;
  identity.workspaceRevision = 1;
  const signal = new AbortController().signal;
  const serviceGraphLock = new TryMutex();
  factory.bindServer({
    identity,
    serviceGraphLock,
    graphOperations: new GraphOperationRegistry(),
    getIdentity: () => identity.snapshot(),
    getShutdownSignal: () => signal,
  } as PiHostServer);
  const readName = () => SessionManager.open(sessionPath, undefined, cwd).getSessionName();
  const request = () => factory.generateSessionTitle("title-request", SESSION_ID, sessionPath);
  return { factory, graph, identity, sessionPath, readName, request, serviceGraphLock, signal };
}

function activateTarget(f: ReturnType<typeof fixture>) {
  f.identity.sessionId = SESSION_ID;
  f.identity.sessionRevision = 1;
  f.graph.sessionManager = SessionManager.open(f.sessionPath, undefined, f.graph.canonicalCwd);
  f.graph.sessionSnapshot = {
    sessionId: SESSION_ID,
    sessionPath: f.sessionPath,
    name: "Original title",
    cwd: f.graph.canonicalCwd,
    revision: 1,
    isIdle: true,
    messages: [{ role: "user", content: "Repair the target conversation" }],
  } as SessionSnapshot;
  vi.spyOn(f.factory, "setActiveSessionName").mockImplementation((name) => {
    f.graph.sessionManager!.appendSessionInfo(name);
    f.graph.sessionSnapshot = { ...f.graph.sessionSnapshot!, name };
    return f.graph.sessionSnapshot;
  });
}

function deferredTitle() {
  let resolve!: (name: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  generate.mockReturnValueOnce(promise);
  return resolve;
}

describe("manual session titles", () => {
  it.each([false, true])(
    "names an inactive session without opening it (archived: %s)",
    async (archived) => {
      const f = fixture();
      let path = f.sessionPath;
      if (archived) {
        const result = await f.factory.archiveSession("archive", SESSION_ID, path);
        if ("error" in result) throw new Error(result.error.message);
        path = result.sessionPath;
      }
      const open = vi.spyOn(f.factory, "openSession");
      const result = await f.factory.generateSessionTitle("title-request", SESSION_ID, path);

      expect(result).toEqual({ sessionId: SESSION_ID, name: "Generated title" });
      expect(SessionManager.open(path).getSessionName()).toBe("Generated title");
      expect(generate).toHaveBeenCalledExactlyOnceWith({
        model: SELECTED_MODEL,
        modelRegistry: f.factory.deps.modelRegistry,
        userPrompt: "Repair the target conversation",
        assistantText: "The target conversation is repaired.",
        signal: f.signal,
      });
      expect(open).not.toHaveBeenCalled();
      expect(f.graph.sessionSnapshot).toBeNull();
    },
  );

  it("updates an idle active session through the normal rename path", async () => {
    const f = fixture();
    activateTarget(f);
    expect(await f.request()).toMatchObject({
      sessionId: SESSION_ID,
      name: "Generated title",
      session: { sessionId: SESSION_ID, name: "Generated title" },
    });
    expect(f.factory.setActiveSessionName).toHaveBeenCalledWith("Generated title");
    expect(f.readName()).toBe("Generated title");
  });

  it("releases the graph lock during completion and deduplicates requests", async () => {
    const f = fixture();
    const finish = deferredTitle();
    const pending = f.request();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(f.serviceGraphLock.isHeld()).toBe(false);
    expect(await f.request()).toMatchObject({ error: { code: "AGENT_BUSY" } });
    expect(generate).toHaveBeenCalledOnce();
    finish("Generated title");
    expect(await pending).toMatchObject({ name: "Generated title" });
    expect(f.factory.pendingTitleRequests.size).toBe(0);
  });

  it("still updates the target after navigating to another session", async () => {
    const f = fixture();
    activateTarget(f);
    const finish = deferredTitle();
    const pending = f.request();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    f.graph.sessionSnapshot = null;
    f.graph.sessionManager = null;
    f.identity.sessionId = "another-session";
    f.identity.bumpSessionRevision();
    finish("Generated title");
    expect(await pending).toEqual({ sessionId: SESSION_ID, name: "Generated title" });
    expect(f.graph.sessionSnapshot).toBeNull();
    expect(f.readName()).toBe("Generated title");
  });

  it.each([false, true])(
    "preserves a manual rename during generation (active: %s)",
    async (active) => {
      const f = fixture();
      if (active) activateTarget(f);
      const finish = deferredTitle();
      const pending = f.request();
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      expect(
        await f.factory.renameSession("manual-rename", SESSION_ID, f.sessionPath, "My title"),
      ).toMatchObject({ name: "My title" });
      finish("Late AI title");
      expect(await pending).toMatchObject({ error: { code: "STALE_REVISION" } });
      expect(f.readName()).toBe("My title");
    },
  );

  it("rejects an outdated title when the conversation has new content", async () => {
    const f = fixture();
    const finish = deferredTitle();
    const pending = f.request();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    SessionManager.open(f.sessionPath).appendMessage({
      role: "user",
      content: "A new task",
      timestamp: 3,
    });
    finish("Late AI title");
    expect(await pending).toMatchObject({ error: { code: "STALE_REVISION" } });
    expect(f.readName()).toBe("Original title");
  });

  it.each(["replacement", "return-to-workspace"])(
    "rejects a result after a workspace %s",
    async (change) => {
      const f = fixture();
      const finish = deferredTitle();
      const pending = f.request();
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      if (change === "replacement") f.factory.graph = { ...f.graph, workspaceId: "workspace-2" };
      else f.identity.bumpWorkspaceRevision();
      finish("Late AI title");
      expect(await pending).toMatchObject({ error: { code: "STALE_REVISION" } });
      expect(f.readName()).toBe("Original title");
      expect(f.factory.pendingTitleRequests.size).toBe(0);
    },
  );

  it("does not recreate a conversation deleted during generation", async () => {
    const f = fixture();
    const finish = deferredTitle();
    const pending = f.request();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(await f.factory.deleteSession("delete", SESSION_ID, f.sessionPath)).toMatchObject({
      deleted: true,
    });
    finish("Late AI title");
    expect(await pending).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
    expect(existsSync(f.sessionPath)).toBe(false);
  });

  it("keeps the old title on provider failure and allows an explicit retry", async () => {
    const f = fixture();
    generate.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect(await f.request()).toMatchObject({
      error: { message: "Title generation failed: Provider unavailable" },
    });
    expect(f.readName()).toBe("Original title");
    expect(f.factory.pendingTitleRequests.size).toBe(0);
    expect(await f.request()).toMatchObject({ name: "Generated title" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not request a title without user text", async () => {
    const f = fixture(false);
    expect(await f.request()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not request a title without a selected model", async () => {
    const f = fixture();
    f.graph.agentSession = { model: PIDECK_NO_MODEL, isIdle: true } as AgentSession;
    expect(await f.request()).toMatchObject({ error: { code: "AGENT_NOT_READY" } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not request a title for a running conversation", async () => {
    const f = fixture();
    activateTarget(f);
    Reflect.set(f.graph.agentSession!, "isIdle", false);
    expect(await f.request()).toMatchObject({ error: { code: "AGENT_BUSY" } });
    expect(generate).not.toHaveBeenCalled();
  });
});
