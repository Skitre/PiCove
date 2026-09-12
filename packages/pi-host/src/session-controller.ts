import {
  createHostError,
  stripAttachmentReferenceBlocks,
  toJsonValue,
  type JsonValue,
} from "@pideck/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { buildSessionUsageReport } from "./session-usage-report.js";
import { searchSessions } from "./session-search.js";

type SdkSessionTreeNode = {
  entry: unknown;
  children: SdkSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

/**
 * SDK tree nodes carry `label: undefined` keys; toJsonValue would turn those
 * into nulls, which the wire contract rejects — optional keys must be absent.
 */
function toWireTreeNode(node: SdkSessionTreeNode): JsonValue {
  return {
    entry: toJsonValue(node.entry),
    children: node.children.map(toWireTreeNode),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.labelTimestamp !== undefined ? { labelTimestamp: node.labelTimestamp } : {}),
  };
}

export function createSessionHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "session.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) throw new Error("No workspace");
          const items = await factory.listSessions();
          return {
            workspaceId: g.workspaceId,
            items: items.map((s) => {
              const runtime = factory.getSessionRuntimeInfo(s.id, s.path);
              return {
                sessionId: s.id,
                sessionPath: s.path,
                name: s.name,
                cwd: s.cwd,
                updatedAt: s.modified?.getTime?.() ?? Date.now(),
                messageCount: s.messageCount,
                archived: s.archived,
                ...(runtime ?? {}),
              };
            }),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.create": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = (ctx.params ?? {}) as { name?: string };
      const result = await factory.createSession(ctx.id, params.name);
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.open": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionPath: string };
      const result = await factory.openSession(ctx.id, params.sessionPath);
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.reload": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const result = await factory.reloadSession(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.archive": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.archiveSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.restore": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.restoreSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.delete": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.deleteSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.cleanupArchived": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const result = await factory.cleanupArchivedSessions(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.getSnapshot": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          return g?.sessionSnapshot ?? null;
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.setName": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "session.setName",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", {
            retryable: true,
          }),
        };
      }

      try {
        const stale = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (stale) return { error: stale };
        const g = factory.getGraph();
        if (!g?.sessionManager || !g.agentSession) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        if (factory.getSessionOperationLock(g.agentSession).isHeld() || !g.agentSession.isIdle) {
          return { error: createHostError("AGENT_BUSY", "Agent is busy", { retryable: true }) };
        }

        const params = ctx.params as { name: string };
        const snapshot = factory.setActiveSessionName(params.name);
        if (!snapshot) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        return { result: snapshot };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "session.rename": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as {
        sessionId: string;
        sessionPath: string;
        name: string;
      };
      const result = await factory.renameSession(
        ctx.id,
        params.sessionId,
        params.sessionPath,
        params.name,
      );
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.generateTitle": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.generateSessionTitle(
        ctx.id,
        params.sessionId,
        params.sessionPath,
      );
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.getEntries": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.sessionManager) throw new Error("No active session");
          const entries = g.sessionManager.getEntries().map((e) => toJsonValue(e));
          return {
            entries,
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getTree": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.sessionManager) throw new Error("No active session");
          return {
            tree: (g.sessionManager.getTree() as SdkSessionTreeNode[]).map(toWireTreeNode),
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getStats": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          const stats = g.agentSession.getSessionStats();
          return {
            messageCount: stats.totalMessages,
            toolCallCount: stats.toolCalls,
            userMessageCount: stats.userMessages,
            assistantMessageCount: stats.assistantMessages,
            toolResultCount: stats.toolResults,
            tokens: {
              input: stats.tokens.input,
              output: stats.tokens.output,
              cacheRead: stats.tokens.cacheRead,
              cacheWrite: stats.tokens.cacheWrite,
              total: stats.tokens.total,
            },
            cost: stats.cost,
            ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getForkPoints": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          return {
            items: g.agentSession.getUserMessagesForForking().map(({ entryId, text }) => ({
              entryId,
              text: stripAttachmentReferenceBlocks(text),
            })),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.fork": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (!g.agentSession.isIdle || factory.getSessionOperationLock(g.agentSession).isHeld()) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      const params = ctx.params as { entryId: string; position?: "before" | "at" };
      const { prepareForkFile } = await import("./session-lifecycle.js");
      const prepared = prepareForkFile({
        sessionFile: g.sessionManager.getSessionFile(),
        canonicalCwd: g.canonicalCwd,
        entryId: params.entryId,
        ...(params.position ? { position: params.position } : {}),
      });
      if ("error" in prepared) return { error: prepared.error };
      // openSession owns graph-operation locking and identity advancement.
      const opened = await factory.openSession(ctx.id, prepared.forkedPath);
      if (opened && typeof opened === "object" && "error" in opened) {
        return { error: opened.error };
      }
      return {
        result: {
          session: opened,
          ...(prepared.selectedText !== undefined ? { selectedText: prepared.selectedText } : {}),
        },
      };
    },

    "session.export": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (!g.agentSession.isIdle || factory.getSessionOperationLock(g.agentSession).isHeld()) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      const params = ctx.params as { format: "html" | "jsonl"; path?: string };
      try {
        const path =
          params.format === "html"
            ? await g.agentSession.exportToHtml(params.path)
            : g.agentSession.exportToJsonl(params.path);
        return { result: { path } };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : "Export failed",
          ),
        };
      }
    },

    "session.usageReport": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) throw new Error("No workspace");
          return buildSessionUsageReport({
            agentDir: factory.deps.agentDir,
            canonicalCwd: g.canonicalCwd,
            workspaceId: g.workspaceId,
          });
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.searchAll": async (ctx) => {
      // Host-scoped read of session files on disk: no workspace graph or lock
      // is involved, so search works across every workspace at any time.
      const params = ctx.params as {
        query: string;
        limit?: number;
        includeArchived?: boolean;
      };
      try {
        const report = await searchSessions({
          agentDir: factory.deps.agentDir,
          query: params.query,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.includeArchived !== undefined
            ? { includeArchived: params.includeArchived }
            : {}),
        });
        return { result: report };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : "Session search failed",
          ),
        };
      }
    },

    "session.getCommands": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          const commands: {
            invocation: string;
            description: string;
            argumentHint?: string;
            kind: "template" | "command" | "skill";
          }[] = [];
          for (const template of g.agentSession.promptTemplates) {
            commands.push({
              invocation: template.name,
              description: template.description,
              ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
              kind: "template",
            });
          }
          try {
            for (const command of g.agentSession.extensionRunner.getRegisteredCommands()) {
              commands.push({
                invocation: command.invocationName,
                description: command.description ?? "",
                kind: "command",
              });
            }
          } catch {
            /* runner may be unavailable mid-reload */
          }
          if (g.resourceLoader) {
            for (const skill of g.resourceLoader.getSkills().skills) {
              commands.push({
                invocation: `skill:${skill.name}`,
                description: skill.description,
                kind: "skill",
              });
            }
          }
          return { commands };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
  };
}
