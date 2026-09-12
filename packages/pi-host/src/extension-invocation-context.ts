import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  AgentSession,
  ExtensionInvocationMetadata,
  ExtensionInvocationRunner,
  ResolvedCommand,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUiOrigin, ExtensionUiSourceKind } from "@pideck/protocol";

export type ResolvedExtensionCommandInvocation = {
  invocation: string;
  command: ResolvedCommand;
};

export type ExtensionInvocationContext = {
  readonly session: AgentSession;
  readonly invocationId: string;
  readonly origin: ExtensionUiOrigin;
  readonly sourceInfo?: SourceInfo;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly invocation?: string;
  active: boolean;
  widgetAttentionRequested: boolean;
};

type ExtensionInvocationCompletionStatus = "completed" | "failed";
type ExtensionInvocationCompletion = (status: ExtensionInvocationCompletionStatus) => void;

export type ExtensionCommandOrigin = ExtensionInvocationContext & {
  readonly runId: string;
  readonly invocation: string;
  readonly origin: Extract<ExtensionUiOrigin, { invocationKind: "command" }>;
};

const invocationStorage = new AsyncLocalStorage<ExtensionInvocationContext>();
const invocationCompletions = new WeakMap<
  ExtensionInvocationContext,
  Set<ExtensionInvocationCompletion>
>();
const UNKNOWN_ORIGIN = Object.freeze({ invocationKind: "unknown" } as const);

function boundedText(value: string, maxLength: number, fallback: string): string {
  const normalized = stripVTControlCharacters(value).trim();
  return normalized.slice(0, maxLength) || fallback;
}

function normalizedPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function entrypointKey(sourceInfo: SourceInfo): string {
  const path = normalizedPath(sourceInfo.path);
  const baseDir = sourceInfo.baseDir ? normalizedPath(sourceInfo.baseDir) : "";
  if (baseDir && (path === baseDir || path.startsWith(`${baseDir}/`))) {
    return path.slice(baseDir.length + (path === baseDir ? 0 : 1)) || ".";
  }
  return path;
}

function sourceKind(sourceInfo: SourceInfo): ExtensionUiSourceKind {
  if (sourceInfo.origin === "package") return "package";
  if (sourceInfo.scope === "temporary" || sourceInfo.path.startsWith("<")) {
    return "synthetic";
  }
  return sourceInfo.scope === "project" ? "project" : "user";
}

function npmPackageName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const specifier = source.slice(4);
  return specifier.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/)?.[1];
}

function stableSourceKey(sourceInfo: SourceInfo): string {
  const source = stripVTControlCharacters(sourceInfo.source).trim();
  const npmName = npmPackageName(source);
  return npmName ? `npm:${npmName}` : source.replace(/#.*$/, "");
}

function sourceDisplayName(sourceInfo: SourceInfo): string {
  const source = stripVTControlCharacters(sourceInfo.source).trim();
  const npmName = npmPackageName(source);
  if (npmName) return boundedText(npmName, 120, "Extension");

  const normalizedSource = normalizedPath(source.replace(/^git:/, "").replace(/#.*$/, ""));
  const sourceLeaf = normalizedSource
    .split("/")
    .at(-1)
    ?.replace(/\.git$/, "");
  const pathLeaf = normalizedPath(sourceInfo.path)
    .split("/")
    .at(-1)
    ?.replace(/\.[^.]+$/, "");
  const syntheticSource = source.match(/^<(.+)>$/)?.[1] ?? source.match(/^extension:(.+)$/)?.[1];
  const syntheticLeaf = syntheticSource
    ? normalizedPath(syntheticSource)
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/, "")
    : undefined;
  return boundedText(syntheticLeaf ?? sourceLeaf ?? pathLeaf ?? "Extension", 120, "Extension");
}

export function normalizeExtensionIdentity(sourceInfo: SourceInfo): {
  extensionId: string;
  extensionDisplayName: string;
  sourceKind: ExtensionUiSourceKind;
} {
  const hash = createHash("sha256")
    .update(
      [
        sourceInfo.scope,
        sourceInfo.origin,
        stableSourceKey(sourceInfo),
        entrypointKey(sourceInfo),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    extensionId: `ext_${hash}`,
    extensionDisplayName: sourceDisplayName(sourceInfo),
    sourceKind: sourceKind(sourceInfo),
  };
}

function originFromMetadata(metadata: ExtensionInvocationMetadata): ExtensionUiOrigin {
  const identity = normalizeExtensionIdentity(metadata.sourceInfo);
  if (metadata.kind === "tool") {
    return {
      ...identity,
      invocationKind: "tool",
      toolName: boundedText(metadata.toolName, 256, "unknown-tool"),
      toolCallId: boundedText(metadata.toolCallId, 256, "unknown-call"),
    };
  }
  const toolName = metadata.toolName
    ? boundedText(metadata.toolName, 256, "unknown-tool")
    : undefined;
  const toolCallId = metadata.toolCallId
    ? boundedText(metadata.toolCallId, 256, "unknown-call")
    : undefined;
  return {
    ...identity,
    invocationKind: "event",
    eventType: boundedText(metadata.eventType, 256, "unknown-event"),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

async function withInvocationContext<T>(
  context: ExtensionInvocationContext,
  run: () => T | Promise<T>,
): Promise<T> {
  let completionStatus: ExtensionInvocationCompletionStatus = "completed";
  try {
    return await invocationStorage.run(context, run);
  } catch (error) {
    completionStatus = "failed";
    throw error;
  } finally {
    context.active = false;
    const callbacks = invocationCompletions.get(context);
    invocationCompletions.delete(context);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(completionStatus);
        } catch {
          // Lifecycle observers must never change Extension callback semantics.
        }
      }
    }
  }
}

export function registerExtensionInvocationCompletion(
  context: ExtensionInvocationContext,
  callback: ExtensionInvocationCompletion,
): () => void {
  if (!context.active) return () => {};
  let callbacks = invocationCompletions.get(context);
  if (!callbacks) {
    callbacks = new Set();
    invocationCompletions.set(context, callbacks);
  }
  callbacks.add(callback);
  return () => {
    callbacks?.delete(callback);
    if (callbacks?.size === 0) invocationCompletions.delete(context);
  };
}

/** Mirror the SDK's extension-command parsing before AgentSession.prompt(). */
export function resolveExtensionCommandInvocation(
  session: AgentSession,
  text: string,
): ResolvedExtensionCommandInvocation | undefined {
  if (!text.startsWith("/")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const invocation = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  if (!invocation) return undefined;
  try {
    const command = session.extensionRunner.getCommand(invocation);
    return command ? { invocation, command } : undefined;
  } catch {
    return undefined;
  }
}

export async function withExtensionCommandOrigin<T>(
  session: AgentSession,
  runId: string,
  resolved: ResolvedExtensionCommandInvocation,
  run: () => Promise<T>,
): Promise<T> {
  const context: ExtensionCommandOrigin = {
    session,
    runId,
    invocation: resolved.invocation,
    invocationId: randomUUID(),
    origin: {
      ...normalizeExtensionIdentity(resolved.command.sourceInfo),
      invocationKind: "command",
      commandName: boundedText(resolved.command.invocationName, 256, resolved.invocation),
    },
    active: true,
    widgetAttentionRequested: false,
  };
  return withInvocationContext(context, run);
}

export function createExtensionInvocationRunner(session: AgentSession): ExtensionInvocationRunner {
  return (metadata, invoke) =>
    withInvocationContext(
      {
        session,
        invocationId: randomUUID(),
        origin: originFromMetadata(metadata),
        sourceInfo: metadata.sourceInfo,
        ...(metadata.kind === "tool" && metadata.signal ? { signal: metadata.signal } : {}),
        active: true,
        widgetAttentionRequested: false,
      },
      invoke,
    );
}

export function getActiveExtensionInvocation(
  session: AgentSession,
): ExtensionInvocationContext | undefined {
  const context = invocationStorage.getStore();
  return context?.active && context.session === session ? context : undefined;
}

export function getActiveExtensionUiOrigin(session: AgentSession): ExtensionUiOrigin {
  return getActiveExtensionInvocation(session)?.origin ?? UNKNOWN_ORIGIN;
}

export function getActiveExtensionCommandOrigin(
  session: AgentSession,
): ExtensionCommandOrigin | undefined {
  const context = getActiveExtensionInvocation(session);
  return context?.origin.invocationKind === "command"
    ? (context as ExtensionCommandOrigin)
    : undefined;
}

/** A command run may request widget attention at most once. */
export function claimExtensionCommandWidgetAttention(origin: ExtensionCommandOrigin): boolean {
  if (origin.widgetAttentionRequested) return false;
  origin.widgetAttentionRequested = true;
  return true;
}
