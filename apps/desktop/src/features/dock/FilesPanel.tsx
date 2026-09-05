import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceDirectoryEntry } from "@pideck/protocol";
import {
  AtSign,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Copy,
  File,
  Folder,
  FolderOpen,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

type FlatNode = { entry: WorkspaceDirectoryEntry; depth: number };

export function workspaceAbsolutePath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  const windows = root.includes("\\");
  const separator = windows ? "\\" : "/";
  const cleanRoot = root.replace(/[\\/]+$/, "");
  const cleanRelative = windows ? relativePath.replace(/\//g, "\\") : relativePath;
  return `${cleanRoot}${separator}${cleanRelative}`;
}

export function flattenVisibleFiles(
  directories: ReadonlyMap<string, WorkspaceDirectoryEntry[]>,
  expanded: ReadonlySet<string>,
): FlatNode[] {
  const rows: FlatNode[] = [];
  const append = (path: string, depth: number) => {
    for (const entry of directories.get(path) ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) append(entry.path, depth + 1);
    }
  };
  append("", 0);
  return rows;
}

export function FilesPanel({
  visible,
  onOpenFile,
  previewParent,
}: {
  visible: boolean;
  onOpenFile?: (entry: WorkspaceDirectoryEntry) => void;
  previewParent?: string;
}) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const setPage = useAppStore((state) => state.setPage);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [directories, setDirectories] = useState<Map<string, WorkspaceDirectoryEntry[]>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceDirectoryEntry[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchGeneration = useRef(0);
  const workspaceKey =
    host && workspace ? `${host.hostInstanceId}:${workspace.id}:${workspace.revision}` : "none";

  useEffect(() => {
    searchGeneration.current += 1;
    setDirectories(new Map());
    setExpanded(new Set());
    setLoading(new Set());
    setErrors(new Map());
    setQuery("");
    setSearchResults(null);
    setSelectedPath(null);
  }, [workspaceKey]);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!host || !workspace) return;
      const hostInstanceId = host.hostInstanceId;
      const workspaceId = workspace.id;
      const workspaceRevision = workspace.revision;
      const isCurrentWorkspace = () => {
        const current = useAppStore.getState();
        return (
          current.host?.hostInstanceId === hostInstanceId &&
          current.workspace?.id === workspaceId &&
          current.workspace?.revision === workspaceRevision
        );
      };
      setLoading((current) => new Set(current).add(path));
      try {
        const response = await hostClient.request(
          "workspace.listDirectory",
          workspaceContext(host, workspace),
          { path },
        );
        if (!response.ok) {
          throw new Error(response.error?.message ?? t("dockFilesListFailed"));
        }
        if (!isCurrentWorkspace()) return;
        setDirectories((items) =>
          new Map(items).set(response.result.path, response.result.entries),
        );
        setErrors((items) => {
          const next = new Map(items);
          next.delete(path);
          return next;
        });
      } catch (error) {
        if (!isCurrentWorkspace()) return;
        setErrors((items) =>
          new Map(items).set(
            path,
            error instanceof Error ? error.message : t("dockFilesListFailed"),
          ),
        );
      } finally {
        if (isCurrentWorkspace()) {
          setLoading((items) => {
            const next = new Set(items);
            next.delete(path);
            return next;
          });
        }
      }
    },
    [host, t, workspace],
  );

  useEffect(() => {
    if (
      visible &&
      host &&
      workspace &&
      !directories.has("") &&
      !loading.has("") &&
      !errors.has("")
    ) {
      void loadDirectory("");
    }
  }, [visible, host, workspace, directories, loading, errors, loadDirectory]);

  useEffect(() => {
    if (!host || !workspace) return;
    const timer = window.setTimeout(() => {
      const paths = visible
        ? [
            ...new Set(["", ...(previewParent === undefined ? [] : [previewParent]), ...expanded]),
          ].slice(0, 128)
        : [];
      void hostClient
        .request("workspace.setDirectoryWatches", workspaceContext(host, workspace), { paths })
        .catch(() => undefined);
    }, 50);
    return () => window.clearTimeout(timer);
  }, [visible, host, workspace, expanded, previewParent]);

  useEffect(() => {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace) return;
    const context = workspaceContext(current.host, current.workspace);
    return () => {
      void hostClient
        .request("workspace.setDirectoryWatches", context, { paths: [] })
        .catch(() => undefined);
    };
  }, [workspaceKey]);

  useEffect(
    () =>
      host && workspace
        ? subscribeValidatedHostEvent(
            "workspace.filesChanged",
            workspaceContext(host, workspace),
            (event) => {
              if (!visible) return;
              for (const path of event.payload.directories) {
                if (path === "" || expanded.has(path)) void loadDirectory(path);
              }
            },
          )
        : undefined,
    [visible, host, workspace, expanded, loadDirectory],
  );

  useEffect(() => {
    const value = query.trim().toLocaleLowerCase();
    if (!value || !host || !workspace) {
      searchGeneration.current += 1;
      setSearchResults(null);
      return;
    }
    const generation = ++searchGeneration.current;
    const timer = window.setTimeout(() => {
      void hostClient
        .request("workspace.searchFiles", workspaceContext(host, workspace), {
          query: value,
          limit: 500,
        })
        .then((response) => {
          if (!response.ok || generation !== searchGeneration.current) return;
          setSearchResults(
            response.result.files.map((entry) => ({
              ...entry,
              name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
              symlink: false,
            })),
          );
        })
        .catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, host, workspace]);

  const rows = useMemo<FlatNode[]>(
    () =>
      searchResults
        ? searchResults.map((entry) => ({ entry, depth: 0 }))
        : flattenVisibleFiles(directories, expanded),
    [searchResults, directories, expanded],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !rows.some((row) => row.entry.path === selectedPath)) {
      setSelectedPath(rows[0]!.entry.path);
    }
  }, [rows, selectedPath]);

  const toggleDirectory = (entry: WorkspaceDirectoryEntry) => {
    if (entry.kind !== "dir" || entry.symlink) return;
    const opening = !expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(entry.path);
      else {
        for (const path of next) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) next.delete(path);
        }
      }
      return next;
    });
    if (opening && !directories.has(entry.path)) void loadDirectory(entry.path);
  };

  const insertReference = (entry: WorkspaceDirectoryEntry) => {
    if (entry.kind !== "file") return;
    setPage("chat");
    requestComposerInsert(`@${entry.path}`);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      pushNotification(t("dockFilesPathCopied"), "info");
    } catch {
      pushNotification(t("dockFilesCopyFailed"), "warning");
    }
  };

  const revealPath = async (path: string) => {
    if (!workspace) return;
    try {
      await invoke("desktop_open_path", {
        path: workspaceAbsolutePath(workspace.canonicalCwd, path),
      });
    } catch {
      pushNotification(t("dockFilesRevealFailed"), "warning");
    }
  };

  const refresh = () => {
    for (const path of ["", ...expanded]) void loadDirectory(path);
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const index = Math.max(
      0,
      rows.findIndex((row) => row.entry.path === selectedPath),
    );
    const row = rows[index]!;
    let nextIndex = index;
    if (event.key === "ArrowDown") nextIndex = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = rows.length - 1;
    else if (event.key === "ArrowRight" && row.entry.kind === "dir") {
      if (!expanded.has(row.entry.path)) toggleDirectory(row.entry);
      else nextIndex = Math.min(rows.length - 1, index + 1);
    } else if (event.key === "ArrowLeft") {
      if (row.entry.kind === "dir" && expanded.has(row.entry.path)) toggleDirectory(row.entry);
      else {
        const parent = row.entry.path.slice(0, row.entry.path.lastIndexOf("/"));
        const parentIndex = rows.findIndex((candidate) => candidate.entry.path === parent);
        if (parentIndex >= 0) nextIndex = parentIndex;
      }
    } else if (event.key === "Enter") {
      if (row.entry.kind === "dir") toggleDirectory(row.entry);
      else onOpenFile?.(row.entry);
    } else {
      return;
    }
    event.preventDefault();
    if (nextIndex !== index) {
      setSelectedPath(rows[nextIndex]!.entry.path);
      virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    }
  };

  const rootError = errors.get("");
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label={t("dockFilesRegion")}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            aria-label={t("dockFilesSearch")}
            value={query}
            placeholder={t("dockFilesSearchPlaceholder")}
            className="h-7 w-full rounded border border-border bg-surface-raised pl-7 pr-7 text-xs outline-none focus:border-focus"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              title={t("dockFilesClearSearch")}
              aria-label={t("dockFilesClearSearchAria")}
              className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center text-muted hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          title={t("dockFilesRefresh")}
          aria-label={t("dockFilesRefresh")}
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={refresh}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          title={t("dockFilesCollapseAll")}
          aria-label={t("dockFilesCollapseAll")}
          disabled={expanded.size === 0}
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-35"
          onClick={() => setExpanded(new Set())}
        >
          <ChevronsUp size={14} />
        </button>
      </div>

      {!host || !workspace ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">
          {t("dockNoWorkspace")}
        </div>
      ) : rootError && !directories.has("") ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted">
          <span>{rootError}</span>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-foreground hover:bg-surface-overlay"
            onClick={() => void loadDirectory("")}
          >
            {t("dockRetry")}
          </button>
        </div>
      ) : loading.has("") && !directories.has("") ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <LoaderCircle size={16} className="animate-spin" />
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          tabIndex={0}
          aria-label={t("dockFilesTree")}
          aria-activedescendant={
            selectedPath ? `file-tree-${encodeURIComponent(selectedPath)}` : undefined
          }
          className="min-h-0 flex-1 overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus"
          onKeyDown={onTreeKeyDown}
        >
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted">
              {query ? t("dockFilesNoMatches") : t("dockFilesEmpty")}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                const entry = row.entry;
                const isDirectory = entry.kind === "dir";
                const isExpanded = isDirectory && expanded.has(entry.path);
                const isSelected = selectedPath === entry.path;
                return (
                  <div
                    key={entry.path}
                    id={`file-tree-${encodeURIComponent(entry.path)}`}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-selected={isSelected}
                    aria-expanded={isDirectory ? isExpanded : undefined}
                    className={`group absolute left-0 top-0 flex h-7 w-full items-center pr-1 text-xs ${
                      isSelected
                        ? "bg-surface-overlay text-foreground"
                        : "text-foreground/85 hover:bg-surface-overlay/60"
                    }`}
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingLeft: query ? 8 : 6 + row.depth * 16,
                    }}
                    onClick={() => {
                      setSelectedPath(entry.path);
                      if (!isDirectory) onOpenFile?.(entry);
                    }}
                    onDoubleClick={() => (isDirectory ? toggleDirectory(entry) : undefined)}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={
                        isDirectory
                          ? t(isExpanded ? "dockFilesCollapseNamed" : "dockFilesExpandNamed", {
                              name: entry.name,
                            })
                          : undefined
                      }
                      className="flex size-5 shrink-0 items-center justify-center text-muted"
                      disabled={!isDirectory}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDirectory(entry);
                      }}
                    >
                      {isDirectory ? (
                        loading.has(entry.path) ? (
                          <LoaderCircle size={12} className="animate-spin" />
                        ) : isExpanded ? (
                          <ChevronDown size={13} />
                        ) : (
                          <ChevronRight size={13} />
                        )
                      ) : null}
                    </button>
                    {entry.symlink ? (
                      <Link2 size={14} className="mr-1.5 shrink-0 text-muted" />
                    ) : isDirectory ? (
                      <Folder size={14} className="mr-1.5 shrink-0 text-accent" />
                    ) : (
                      <File size={14} className="mr-1.5 shrink-0 text-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={entry.path}>
                      {query ? entry.path : entry.name}
                    </span>
                    <div className="ml-1 hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
                      {!isDirectory && (
                        <button
                          type="button"
                          title={t("dockFilesInsertReference")}
                          aria-label={t("dockFilesInsertReferenceTo", {
                            path: entry.path,
                          })}
                          className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            insertReference(entry);
                          }}
                        >
                          <AtSign size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        title={t("dockFilesCopyRelativePath")}
                        aria-label={t("dockFilesCopyPath", { path: entry.path })}
                        className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyPath(entry.path);
                        }}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        type="button"
                        title={isDirectory ? t("dockFilesOpenFolder") : t("dockFilesReveal")}
                        aria-label={
                          isDirectory
                            ? t("dockFilesOpenFolderNamed", { path: entry.path })
                            : t("dockFilesRevealNamed", { path: entry.path })
                        }
                        className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          void revealPath(entry.path);
                        }}
                      >
                        <FolderOpen size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
