import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  AtSign,
  Check,
  Copy,
  File,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
  Save,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { FilesPanel, workspaceAbsolutePath } from "./FilesPanel";
import { FileToolButton } from "./FileToolButton";
import {
  clearFileSession,
  ensureFileCanLeave,
  fileIsDirty,
  openWorkspaceFile,
  refreshOpenFile,
  reloadConflict,
  saveOpenFile,
  useFileSession,
} from "./file-session";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { requestComposerInsert } from "../../lib/composer-insert";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { workspaceContext } from "../../lib/bridge/host-context";
import { Dialog } from "../../components/Dialog";
import "./file-preview.css";

const CodeEditor = lazy(() =>
  import("./FileCodeEditor").then((m) => ({ default: m.FileCodeEditor })),
);
const ConflictDiff = lazy(() =>
  import("./FileCodeEditor").then((m) => ({ default: m.FileConflictDiff })),
);
const ImagePreview = lazy(() =>
  import("./FileMediaPreview").then((m) => ({ default: m.ImageFilePreview })),
);
const PdfPreview = lazy(() =>
  import("./FileMediaPreview").then((m) => ({ default: m.PdfFilePreview })),
);
const Markdown = lazy(() =>
  import("../chat/MarkdownMessage").then((m) => ({ default: m.MarkdownMessage })),
);

export function WorkspaceFiles({ visible }: { visible: boolean }) {
  const t = useT();
  const session = useFileSession();
  const { file, path, text, loading, saving, error, conflict } = session;
  const workspace = useAppStore((s) => s.workspace);
  const host = useAppStore((s) => s.host);
  const connecting = useAppStore((s) => s.connecting || s.rehydrating);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [width, setWidth] = useState(460);
  const [maximized, setMaximized] = useState(false);
  const [left, setLeft] = useState(0);
  const [showTree, setShowTree] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [markdownMode, setMarkdownMode] = useState<"live" | "source" | "preview">("live");
  const [compare, setCompare] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"reload" | "overwrite" | "mixed" | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const pendingOpen = useRef(0);
  const wide = width >= 640;
  const dirty = fileIsDirty(session);
  const disconnected = !host || !workspace || connecting || workspace.canonicalCwd !== session.root;
  const markdown = /\.(md|mdx|markdown)$/i.test(path ?? "");
  const parentPath = path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const editorReadOnly =
    disconnected || (file?.kind === "text" && file.mixedLineEndings && !session.mixedConfirmed);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!maximized) return;
    const main = document.querySelector("[data-pideck-app] main");
    const update = () => setLeft(main?.getBoundingClientRect().left ?? 0);
    update();
    const observer = new ResizeObserver(update);
    if (main) observer.observe(main);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [maximized]);

  useEffect(() => {
    if (!visible || !host || !workspace || connecting) return;
    const current = useFileSession.getState();
    if (
      current.root &&
      workspace.canonicalCwd !== current.root &&
      !fileIsDirty(current) &&
      !current.saving
    ) {
      clearFileSession();
      setShowContent(false);
    } else if (current.root === workspace.canonicalCwd) void refreshOpenFile();
  }, [visible, host, workspace, connecting]);

  useEffect(() => {
    if (!visible || !host || !workspace) return;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = subscribeValidatedHostEvent(
      "workspace.filesChanged",
      workspaceContext(host, workspace),
      (event) => {
        if (!event.payload.directories.includes(parentPath)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refreshOpenFile(), 200);
      },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [visible, host, workspace, parentPath]);

  const openFile = useCallback(async (selected: string) => {
    const request = ++pendingOpen.current;
    const previous = useFileSession.getState();
    const opening = openWorkspaceFile(selected);
    // Display the content surface immediately for loading/error feedback.
    if (!fileIsDirty(previous)) setShowContent(true);
    const opened = await opening;
    if (request !== pendingOpen.current) return;
    if (opened || useFileSession.getState().path === selected) {
      setShowContent(true);
      setMarkdownMode("live");
      setCompare(false);
    }
  }, []);

  const insert = () => {
    if (!path || disconnected) return;
    useAppStore.getState().setPage("chat");
    requestComposerInsert(`@${path}`);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path ?? "");
      pushNotification(t("dockFilesPathCopied"), "info");
    } catch {
      pushNotification(t("dockFilesCopyFailed"), "warning");
    }
  };
  const systemOpen = async () => {
    if (!session.root || !path) return;
    try {
      await invoke("desktop_open_path", { path: workspaceAbsolutePath(session.root, path) });
    } catch {
      pushNotification(t("dockFilesRevealFailed"), "warning");
    }
  };
  const refresh = async () => {
    if (await ensureFileCanLeave()) {
      if (!file && path) void openWorkspaceFile(path);
      else await refreshOpenFile();
    }
  };
  const treeVisible = wide ? showTree : !showContent;
  const contentVisible = wide || showContent;

  return (
    <div
      ref={container}
      data-file-workspace
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
      style={
        maximized && visible
          ? { position: "fixed", top: 40, bottom: 0, right: 0, left, zIndex: 40 }
          : undefined
      }
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveOpenFile();
        }
        if (event.key === "Escape" && maximized && !confirmAction && !session.leavePrompt) {
          event.preventDefault();
          setMaximized(false);
        }
      }}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 border-b border-border px-2 py-1">
        {!wide && showContent && (
          <FileToolButton label={t("fileBackToTree")} onClick={() => setShowContent(false)}>
            <ArrowLeft size={15} />
          </FileToolButton>
        )}
        <div className="min-w-0 flex-1 basis-24 py-1" title={path ?? t("dockFiles")}>
          <div className="truncate text-xs font-medium">
            {path?.split("/").pop() ?? t("dockFiles")}
            {dirty ? " *" : ""}
          </div>
          {parentPath && <div className="truncate text-[11px] text-muted">{parentPath}/</div>}
        </div>
        <div className="flex shrink-0 items-center">
          {file?.kind === "text" && (
            <FileToolButton
              label={saving ? t("fileSaving") : t("fileSave")}
              disabled={!dirty || saving || disconnected}
              onClick={() => void saveOpenFile()}
            >
              {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
            </FileToolButton>
          )}
          {path && (
            <>
              <FileToolButton
                label={t("dockFilesRefresh")}
                disabled={saving || loading || disconnected}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
              </FileToolButton>
              <FileToolButton label={t("dockFilesCopyRelativePath")} onClick={() => void copy()}>
                <Copy size={14} />
              </FileToolButton>
              <FileToolButton
                label={t("dockFilesInsertReference")}
                disabled={disconnected}
                onClick={insert}
              >
                <AtSign size={14} />
              </FileToolButton>
              <FileToolButton label={t("fileSystemOpen")} onClick={() => void systemOpen()}>
                <FolderOpen size={14} />
              </FileToolButton>
            </>
          )}
          {wide && (
            <FileToolButton
              label={t("fileToggleTree")}
              pressed={showTree}
              onClick={() => setShowTree(!showTree)}
            >
              <FolderTree size={14} />
            </FileToolButton>
          )}
          <FileToolButton
            label={t(maximized ? "fileRestore" : "fileMaximize")}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </FileToolButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={`${contentVisible ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}>
          {disconnected && path && (
            <p role="status" className="border-b border-border p-2 text-xs text-warning">
              {t("fileDisconnected")}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words border-b border-border p-2 text-xs text-danger">
              {error}
            </p>
          )}
          {conflict && (
            <div className="border-b border-border p-2 text-xs">
              <p className="text-warning">{t("fileConflict")}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <button
                  className="rounded border border-border px-2 py-1"
                  onClick={() => setCompare(!compare)}
                >
                  {t(compare ? "fileSource" : "fileCompare")}
                </button>
                <button
                  className="rounded border border-border px-2 py-1"
                  onClick={() => setConfirmAction("reload")}
                >
                  {t("fileReloadDisk")}
                </button>
                <button
                  className="rounded border border-border px-2 py-1"
                  disabled={saving}
                  onClick={() => setConfirmAction("overwrite")}
                >
                  {t("fileOverwrite")}
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted">
              <LoaderCircle size={16} className="animate-spin" />
              {t("fileLoading")}
            </div>
          ) : !file ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
              <File size={32} />
              <span className="text-sm">{t("fileOpen")}</span>
            </div>
          ) : (
            <Suspense fallback={<div className="p-3 text-xs text-muted">{t("fileLoading")}</div>}>
              {file.kind === "text" && (
                <>
                  <div className="file-tools flex-wrap">
                    {markdown && (
                      <div
                        className="flex rounded border border-border text-xs"
                        role="group"
                        aria-label={t("fileView")}
                      >
                        {(["live", "source", "preview"] as const).map((mode) => (
                          <button
                            key={mode}
                            aria-pressed={markdownMode === mode}
                            className={`px-2 py-1 ${markdownMode === mode ? "bg-surface-overlay" : ""}`}
                            onClick={() => setMarkdownMode(mode)}
                          >
                            {t(
                              mode === "live"
                                ? "fileLivePreview"
                                : mode === "source"
                                  ? "fileSource"
                                  : "filePreview",
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    <span className="min-w-0 flex-1 text-[11px] text-muted">
                      UTF-8{file.bom ? " BOM" : ""} · {file.lineEnding.toUpperCase()}
                    </span>
                    {!dirty && <Check size={12} className="text-muted" />}
                  </div>
                  {file.mixedLineEndings && !session.mixedConfirmed && (
                    <div className="border-b border-border p-2 text-xs text-warning">
                      {t("fileMixedLineEndings", { ending: file.lineEnding.toUpperCase() })}{" "}
                      <button
                        className="rounded border border-border px-2 py-1 text-foreground"
                        onClick={() => setConfirmAction("mixed")}
                      >
                        {t("fileEnableEditing")}
                      </button>
                    </div>
                  )}
                  {compare && conflict && (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="flex justify-around p-2 text-xs text-muted">
                        <span>{t("fileDiskVersion")}</span>
                        <span>{t("fileLocalVersion")}</span>
                      </div>
                      <ConflictDiff disk={conflict.text} local={text} />
                    </div>
                  )}
                  <div
                    className={`${(compare && conflict) || (markdown && markdownMode === "preview") ? "hidden" : "block"} min-h-0 flex-1`}
                  >
                    <CodeEditor
                      key={`${session.root}:${path}:${session.revision}`}
                      path={path!}
                      text={text}
                      readOnly={editorReadOnly}
                      livePreview={markdown && markdownMode === "live"}
                    />
                  </div>
                  {markdown && markdownMode === "preview" && !(compare && conflict) && (
                    <div className="min-h-0 flex-1 overflow-auto p-4">
                      <Markdown content={text} />
                    </div>
                  )}
                </>
              )}
              {file.kind === "image" && (
                <ImagePreview
                  key={session.revision}
                  data={file.data}
                  mediaType={file.mediaType}
                  name={file.path}
                />
              )}
              {file.kind === "pdf" && <PdfPreview key={session.revision} data={file.data} />}
              {file.kind === "unsupported" && (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted">
                  {t(file.reason === "tooLarge" ? "fileTooLarge" : "fileUnsupported")}
                </div>
              )}
            </Suspense>
          )}
        </div>
        <div
          className={`${treeVisible ? "flex" : "hidden"} min-h-0 min-w-0 flex-col ${wide ? "w-[220px] shrink-0 border-l border-border" : "flex-1"}`}
        >
          <FilesPanel
            visible={visible}
            onOpenFile={(entry) => void openFile(entry.path)}
            previewParent={
              path && session.root === workspace?.canonicalCwd ? parentPath : undefined
            }
          />
        </div>
      </div>
      {confirmAction && (
        <Dialog
          title={t(
            confirmAction === "mixed"
              ? "fileEnableEditing"
              : confirmAction === "reload"
                ? "fileReloadDisk"
                : "fileOverwrite",
          )}
          confirmLabel={t("fileConfirm")}
          tone="warning"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            if (confirmAction === "mixed") useFileSession.setState({ mixedConfirmed: true });
            if (confirmAction === "reload") {
              reloadConflict();
              setCompare(false);
            }
            if (confirmAction === "overwrite" && conflict) {
              void saveOpenFile(conflict.version);
              setCompare(false);
            }
            setConfirmAction(null);
          }}
        >
          <p>
            {t(
              confirmAction === "mixed"
                ? "fileNormalizeConfirm"
                : confirmAction === "reload"
                  ? "fileReloadConfirm"
                  : "fileOverwriteConfirm",
            )}
          </p>
        </Dialog>
      )}
    </div>
  );
}
