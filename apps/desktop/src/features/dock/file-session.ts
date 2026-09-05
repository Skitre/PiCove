import { create } from "zustand";
import type { WorkspaceFilePreview, WorkspaceTextFile } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { tCurrent } from "../../lib/i18n/use-t";

type FileSession = {
  root: string | null;
  path: string | null;
  file: WorkspaceFilePreview | null;
  text: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: WorkspaceTextFile | null;
  revision: number;
  mixedConfirmed: boolean;
  leavePrompt: boolean;
};

export const useFileSession = create<FileSession>(() => ({
  root: null,
  path: null,
  file: null,
  text: "",
  loading: false,
  saving: false,
  error: null,
  conflict: null,
  revision: 0,
  mixedConfirmed: false,
  leavePrompt: false,
}));
export const fileIsDirty = (s: FileSession = useFileSession.getState()) =>
  s.file?.kind === "text" && s.text !== s.file.text;
let generation = 0;
let leavePromise: Promise<boolean> | null = null;
let resolveLeave: ((answer: boolean) => void) | null = null;

export function fileWorkspaceForRecovery(fallback: string | undefined) {
  const session = useFileSession.getState();
  return (fileIsDirty(session) || session.saving ? session.root : null) ?? fallback;
}

export async function ensureFileCanChangeWorkspace(cwd: string): Promise<boolean> {
  if (cwd === useFileSession.getState().root) return true;
  return ensureFileCanLeave();
}

export async function ensureFileCanLeave(): Promise<boolean> {
  if (!fileIsDirty() && !useFileSession.getState().saving) return true;
  if (leavePromise) return leavePromise;
  useFileSession.setState({ leavePrompt: true });
  leavePromise = new Promise<boolean>((resolve) => {
    resolveLeave = resolve;
  });
  return leavePromise;
}

export async function answerFileLeave(answer: "save" | "discard" | "cancel") {
  if (useFileSession.getState().saving) return;
  if (answer === "save" && !(await saveOpenFile())) {
    useFileSession.setState({ leavePrompt: false });
    resolveLeave?.(false);
  } else {
    if (answer === "discard") {
      const s = useFileSession.getState();
      useFileSession.setState({
        text: s.file?.kind === "text" ? s.file.text : "",
        conflict: null,
        revision: s.revision + 1,
      });
    }
    useFileSession.setState({ leavePrompt: false });
    resolveLeave?.(answer !== "cancel");
  }
  resolveLeave = null;
  leavePromise = null;
}

function contextFor(root: string | null) {
  const { host, workspace, connecting, rehydrating } = useAppStore.getState();
  if (!host || !workspace || connecting || rehydrating || workspace.canonicalCwd !== root)
    throw new Error(tCurrent("fileDisconnected"));
  return { host, workspace, context: workspaceContext(host, workspace) };
}

function isCurrent(context: ReturnType<typeof contextFor>) {
  const current = useAppStore.getState();
  return (
    current.host?.hostInstanceId === context.host.hostInstanceId &&
    current.workspace?.id === context.workspace.id &&
    current.workspace?.revision === context.workspace.revision
  );
}

export async function openWorkspaceFile(path: string): Promise<boolean> {
  const root = useAppStore.getState().workspace?.canonicalCwd;
  if (!root) return false;
  const old = useFileSession.getState();
  if (old.root === root && old.path === path && old.file) return true;
  if (!(await ensureFileCanLeave())) return false;
  const request = ++generation;
  useFileSession.setState({
    root,
    path,
    file: null,
    text: "",
    loading: true,
    error: null,
    conflict: null,
    mixedConfirmed: false,
    revision: old.revision + 1,
  });
  try {
    const ctx = contextFor(root);
    const response = await hostClient.request("workspace.readFilePreview", ctx.context, { path });
    if (request !== generation || !isCurrent(ctx)) return false;
    if (!response.ok) throw new Error(response.error.message);
    useFileSession.setState({
      file: response.result,
      text: response.result.kind === "text" ? response.result.text : "",
    });
    return true;
  } catch (error) {
    if (request === generation)
      useFileSession.setState({ error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    if (request === generation) useFileSession.setState({ loading: false });
  }
}

export async function refreshOpenFile() {
  const before = useFileSession.getState();
  if (!before.path || before.saving || before.loading) return;
  const request = ++generation;
  try {
    const ctx = contextFor(before.root);
    const response = await hostClient.request("workspace.readFilePreview", ctx.context, {
      path: before.path,
    });
    if (request !== generation || !isCurrent(ctx)) return;
    if (!response.ok) throw new Error(response.error.message);
    const current = useFileSession.getState();
    if (current.saving) return;
    const file = response.result;
    if (fileIsDirty(current)) {
      if (file.kind !== "text") {
        useFileSession.setState({ error: tCurrent("fileChangedType") });
      } else {
        useFileSession.setState({
          conflict:
            current.file?.kind === "text" && file.version !== current.file.version ? file : null,
          error: null,
        });
      }
    } else if (
      file.kind === "text" &&
      current.file?.kind === "text" &&
      file.version === current.file.version
    ) {
      useFileSession.setState({ error: null, conflict: null });
    } else {
      useFileSession.setState({
        file,
        text: file.kind === "text" ? file.text : "",
        conflict: null,
        error: null,
        mixedConfirmed: false,
        revision: current.revision + 1,
      });
    }
  } catch (error) {
    if (request === generation)
      useFileSession.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function saveOpenFile(overrideVersion?: string): Promise<boolean> {
  const start = useFileSession.getState();
  if (start.file?.kind !== "text" || !start.path || start.saving) return false;
  if (!fileIsDirty(start)) return true;
  if (start.conflict && !overrideVersion) return false;
  ++generation;
  useFileSession.setState({ saving: true, error: null });
  try {
    const ctx = contextFor(start.root);
    const response = await hostClient.request("workspace.writeTextFile", ctx.context, {
      path: start.path,
      text: start.text,
      expectedVersion: overrideVersion ?? start.file.version,
    });
    if (!isCurrent(ctx)) throw new Error(tCurrent("fileDisconnected"));
    if (!response.ok) {
      if (response.error.code === "FILE_CONFLICT") {
        useFileSession.setState({ saving: false });
        await refreshOpenFile();
        return false;
      }
      throw new Error(response.error.message);
    }
    useFileSession.setState({ file: response.result, conflict: null, mixedConfirmed: true });
    return !fileIsDirty();
  } catch (error) {
    useFileSession.setState({ error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    useFileSession.setState({ saving: false });
  }
}

export function reloadConflict() {
  const state = useFileSession.getState();
  if (!state.conflict) return;
  useFileSession.setState({
    file: state.conflict,
    text: state.conflict.text,
    conflict: null,
    error: null,
    mixedConfirmed: false,
    revision: state.revision + 1,
  });
}

export function clearFileSession() {
  ++generation;
  useFileSession.setState({
    root: null,
    path: null,
    file: null,
    text: "",
    error: null,
    conflict: null,
    loading: false,
    mixedConfirmed: false,
    revision: useFileSession.getState().revision + 1,
  });
}
