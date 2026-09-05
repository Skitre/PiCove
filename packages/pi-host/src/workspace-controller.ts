import { createHostError } from "@pideck/protocol";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { WorkspaceFileService } from "./workspace-files.js";
import {
  FileConflictError,
  FileWorkspaceChangedError,
  readWorkspaceFilePreview,
  writeWorkspaceTextFile,
} from "./workspace-file-content.js";
import type { GitService } from "./git-service.js";

export function createWorkspaceHandlers(
  factory: WorkspaceGraphFactory,
  fileService = new WorkspaceFileService(),
  gitService?: GitService,
): Partial<Record<string, MethodHandler>> {
  return {
    "workspace.readFilePreview": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const graph = factory.getGraph();
      if (!graph) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      try {
        const result = await readWorkspaceFilePreview(
          graph.canonicalCwd,
          (ctx.params as { path: string }).path,
        );
        const changed = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return changed ? { error: changed } : { result };
      } catch (error) {
        return {
          error: createHostError(
            "FILE_READ_FAILED",
            error instanceof Error ? error.message : "Unable to read file",
          ),
        };
      }
    },
    "workspace.writeTextFile": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const graph = factory.getGraph();
      if (!graph) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { path: string; text: string; expectedVersion: string };
      try {
        return {
          result: await writeWorkspaceTextFile(
            graph.canonicalCwd,
            params.path,
            params.text,
            params.expectedVersion,
            () => !factory.checkIdentity(ctx.context, { requireWorkspace: true }),
          ),
        };
      } catch (error) {
        return {
          error: createHostError(
            error instanceof FileConflictError
              ? "FILE_CONFLICT"
              : error instanceof FileWorkspaceChangedError
                ? "STALE_REVISION"
                : "FILE_WRITE_FAILED",
            error instanceof Error ? error.message : "Unable to save file",
          ),
        };
      }
    },
    "workspace.setCurrent": async (ctx) => {
      const params = ctx.params as { cwd: string };
      // First setCurrent uses expectedWorkspaceId=null, revision 0
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      // Allow initial: expectedWorkspaceId null and revision 0 when no workspace yet
      const server = factory.getServer();
      if (server && server.identity.workspaceId === null) {
        if (
          ctx.context.expectedWorkspaceId !== null ||
          ctx.context.expectedWorkspaceRevision !== 0
        ) {
          // still validate host
          if (ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId) {
            return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
          }
        } else if (ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId) {
          return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
        }
      } else if (stale) {
        return { error: stale };
      }

      fileService.dispose();
      const result = await factory.setCurrent(params.cwd, ctx.id);
      if ("error" in result) return { error: result.error };
      gitService?.stopWatching();
      return { result };
    },

    "workspace.getCurrent": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      const server = factory.getServer();
      if (server && server.identity.workspaceId === null) {
        if (ctx.context.expectedHostInstanceId !== server.identity.hostInstanceId) {
          return { error: createHostError("STALE_REVISION", "Host instance mismatch") };
        }
        return { result: null };
      }
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) return { result: null };
      return { result: factory.buildWorkspaceSnapshot(g) };
    },

    "workspace.searchFiles": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { query: string; limit?: number };
      const limit = params.limit ?? 30;
      return {
        result: await searchWorkspaceFiles(g.canonicalCwd, params.query, limit),
      };
    },

    "workspace.listDirectory": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      if (!g) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { path: string };
      try {
        return { result: await fileService.listDirectory(g.canonicalCwd, params.path) };
      } catch (error) {
        return {
          error: createHostError(
            "INVALID_REQUEST",
            error instanceof Error ? error.message : "Unable to list directory",
          ),
        };
      }
    },

    "workspace.setDirectoryWatches": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g || !server) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { paths: string[] };
      const root = g.canonicalCwd;
      const workspaceId = g.workspaceId;
      const workspaceRevision = g.revision;
      try {
        const paths = await fileService.setDirectoryWatches(root, params.paths, (directories) => {
          const current = factory.getGraph();
          const currentServer = factory.getServer();
          if (
            !current ||
            !currentServer ||
            current.canonicalCwd !== root ||
            current.workspaceId !== workspaceId ||
            current.revision !== workspaceRevision
          ) {
            return;
          }
          currentServer.emit("workspace.filesChanged", { directories });
        });
        return { result: { paths } };
      } catch (error) {
        return {
          error: createHostError(
            "INVALID_REQUEST",
            error instanceof Error ? error.message : "Unable to watch directories",
          ),
        };
      }
    },
  };
}

const SEARCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "Pods",
  ".idea",
  ".vs",
]);
const SEARCH_MAX_SCANNED = 20_000;

type SearchEntry = { path: string; kind: "file" | "dir" };

/**
 * Minimal .gitignore matcher: supports blank/comment lines, trailing-`/`
 * dir-only patterns, leading-`/` anchoring, `*` within a segment and `**`.
 * Negations are ignored (over-hiding is acceptable for completion).
 */
export function gitignoreLineToRegex(line: string): { re: RegExp; dirOnly: boolean } | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return null;
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (!pattern) return null;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, ".*");
  // Unanchored patterns match at any path segment boundary.
  const prefix = anchored ? "^" : "(^|/)";
  return { re: new RegExp(`${prefix}${escaped}(/|$)`), dirOnly };
}

type IgnoreRule = { re: RegExp; dirOnly: boolean; baseRel: string };

function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const scoped = rule.baseRel
      ? rel.startsWith(`${rule.baseRel}/`)
        ? rel.slice(rule.baseRel.length + 1)
        : null
      : rel;
    if (scoped !== null && rule.re.test(scoped)) return true;
  }
  return false;
}

/** LiveAgent-style ranking: filename prefix < path prefix < filename substring
 * < rest, then shallower first, dirs first, alphabetical. */
export function searchSortKey(entry: SearchEntry, query: string): [number, number, number, string] {
  const path = entry.path.toLocaleLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const rank = !query
    ? 3
    : name.startsWith(query)
      ? 0
      : path.startsWith(query)
        ? 1
        : name.includes(query)
          ? 2
          : 3;
  const depth = entry.path.split("/").length;
  return [rank, depth, entry.kind === "dir" ? 0 : 1, entry.path];
}

/**
 * One-shot workspace snapshot for @-completion: full recursive walk bounded
 * by scan count, honoring .gitignore files plus a hard-coded skip list.
 * The client filters keystrokes against this snapshot and only refetches
 * when its query stops extending the snapshot's query.
 */
async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit: number,
): Promise<{ files: SearchEntry[]; truncated: boolean }> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const needle = query.trim().toLocaleLowerCase();
  const matches: SearchEntry[] = [];
  let scanned = 0;
  let truncated = false;

  const queue: { abs: string; rel: string; rules: IgnoreRule[] }[] = [
    { abs: root, rel: "", rules: [] },
  ];
  while (queue.length > 0) {
    if (scanned >= SEARCH_MAX_SCANNED) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    let rules = dir.rules;
    if (entries.some((entry) => entry.isFile() && entry.name === ".gitignore")) {
      try {
        const raw = await readFile(join(dir.abs, ".gitignore"), "utf8");
        const local = raw
          .split(/\r?\n/)
          .map(gitignoreLineToRegex)
          .filter((rule): rule is NonNullable<typeof rule> => rule !== null)
          .map((rule) => ({ ...rule, baseRel: dir.rel }));
        if (local.length > 0) rules = [...rules, ...local];
      } catch {
        /* unreadable .gitignore — walk without it */
      }
    }

    for (const entry of entries) {
      if (scanned >= SEARCH_MAX_SCANNED) {
        truncated = true;
        break;
      }
      scanned += 1;
      const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      if (isDir) {
        if (SEARCH_IGNORED_DIRS.has(entry.name) || isIgnored(rules, rel, true)) continue;
        if (!needle || rel.toLocaleLowerCase().includes(needle)) {
          matches.push({ path: rel, kind: "dir" });
        }
        queue.push({ abs: join(dir.abs, entry.name), rel, rules });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnored(rules, rel, false)) continue;
      if (!needle || rel.toLocaleLowerCase().includes(needle)) {
        matches.push({ path: rel, kind: "file" });
      }
    }
  }

  matches.sort((a, b) => {
    const ka = searchSortKey(a, needle);
    const kb = searchSortKey(b, needle);
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    }
    return ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0;
  });
  if (matches.length > limit) {
    truncated = true;
    matches.length = limit;
  }
  return { files: matches, truncated };
}
