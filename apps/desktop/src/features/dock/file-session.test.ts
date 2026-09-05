import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTextFile } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import {
  answerFileLeave,
  clearFileSession,
  ensureFileCanLeave,
  ensureFileCanChangeWorkspace,
  fileIsDirty,
  fileWorkspaceForRecovery,
  openWorkspaceFile,
  refreshOpenFile,
  reloadConflict,
  saveOpenFile,
  useFileSession,
} from "./file-session";

vi.mock("../../lib/bridge/host-client", () => ({ hostClient: { request: vi.fn() } }));
const request = vi.mocked(hostClient.request);
const file = (text = "old", version = "a".repeat(64)): WorkspaceTextFile => ({
  kind: "text",
  path: "code.ts",
  text,
  version,
  sizeBytes: text.length,
  bom: false,
  lineEnding: "lf",
  mixedLineEndings: false,
});
const response = (result: unknown) => ({ ok: true, result }) as never;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFileSession();
  useAppStore.setState({
    host: { hostInstanceId: "host" } as never,
    workspace: { id: "workspace", revision: 1, canonicalCwd: "/project" } as never,
    connecting: false,
    rehydrating: false,
  });
  useFileSession.setState({
    root: "/project",
    path: "code.ts",
    file: file(),
    text: "old",
    saving: false,
  });
});

describe("file editing state", () => {
  it("keeps typing performed during save dirty against the saved snapshot", async () => {
    const pending = deferred<never>();
    request.mockReturnValueOnce(pending.promise);
    useFileSession.setState({ text: "first" });
    const save = saveOpenFile();
    useFileSession.setState({ text: "second" });
    pending.resolve(response(file("first", "b".repeat(64))));
    expect(await save).toBe(false);
    expect(useFileSession.getState().text).toBe("second");
    expect(fileIsDirty()).toBe(true);
    expect(useFileSession.getState().file).toMatchObject({ text: "first" });
  });
  it("retains edits after errors and never sends a disconnected save", async () => {
    useFileSession.setState({ text: "my edit" });
    request.mockRejectedValueOnce(new Error("permission denied"));
    expect(await saveOpenFile()).toBe(false);
    expect(useFileSession.getState()).toMatchObject({
      text: "my edit",
      saving: false,
      error: "permission denied",
    });
    useAppStore.setState({ host: null });
    expect(await saveOpenFile()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("refreshes clean files but preserves edits and offers the external snapshot", async () => {
    request.mockResolvedValueOnce(response(file("disk", "b".repeat(64))));
    await refreshOpenFile();
    expect(useFileSession.getState().text).toBe("disk");
    useFileSession.setState({ text: "mine" });
    request.mockResolvedValueOnce(response(file("disk again", "c".repeat(64))));
    await refreshOpenFile();
    expect(useFileSession.getState()).toMatchObject({
      text: "mine",
      conflict: { text: "disk again" },
    });
    expect(await saveOpenFile()).toBe(false);
    reloadConflict();
    expect(useFileSession.getState().text).toBe("disk again");
    expect(fileIsDirty()).toBe(false);
  });
  it("a conflict response retains edits and fetches the new disk version", async () => {
    useFileSession.setState({ text: "mine" });
    request
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "FILE_CONFLICT", message: "changed" },
      } as never)
      .mockResolvedValueOnce(response(file("theirs", "b".repeat(64))));
    expect(await saveOpenFile()).toBe(false);
    expect(useFileSession.getState()).toMatchObject({ text: "mine", conflict: { text: "theirs" } });
    request.mockResolvedValueOnce(response(file("mine", "c".repeat(64))));
    expect(await saveOpenFile("b".repeat(64))).toBe(true);
    expect(request).toHaveBeenLastCalledWith("workspace.writeTextFile", expect.anything(), {
      path: "code.ts",
      text: "mine",
      expectedVersion: "b".repeat(64),
    });
  });
  it("discards stale reads after another file is selected", async () => {
    const first = deferred<never>();
    request
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(response({ ...file("new"), path: "second.ts" }));
    const stale = openWorkspaceFile("first.ts");
    await Promise.resolve();
    await openWorkspaceFile("second.ts");
    first.resolve(response({ ...file("stale"), path: "first.ts" }));
    await stale;
    expect(useFileSession.getState()).toMatchObject({ path: "second.ts", text: "new" });
  });
  it("does not apply a read from a retired host", async () => {
    const pending = deferred<never>();
    request.mockReturnValueOnce(pending.promise);
    const refresh = refreshOpenFile();
    useAppStore.setState({ host: { hostInstanceId: "replacement" } as never });
    pending.resolve(response(file("old host response")));
    await refresh;
    expect(useFileSession.getState().text).toBe("old");
  });
});

describe("unsaved change guard", () => {
  it("restores the edited workspace after a host restart without discarding or saving", async () => {
    useFileSession.setState({ text: "未保存内容" });
    useAppStore.setState({ host: null, workspace: null, connecting: true });
    const cwd = fileWorkspaceForRecovery("/default-project");
    expect(cwd).toBe("/project");
    expect(await ensureFileCanChangeWorkspace(cwd!)).toBe(true);
    expect(useFileSession.getState()).toMatchObject({ text: "未保存内容", leavePrompt: false });
    expect(request).not.toHaveBeenCalled();
    useAppStore.setState({
      host: { hostInstanceId: "new-host" } as never,
      workspace: { id: "new-workspace", revision: 1, canonicalCwd: cwd } as never,
      connecting: false,
    });
    request.mockResolvedValueOnce(response(file("external edit", "b".repeat(64))));
    await refreshOpenFile();
    expect(useFileSession.getState()).toMatchObject({
      text: "未保存内容",
      conflict: { text: "external edit" },
    });
  });
  it("still guards a different workspace and preserves edits when cancelled", async () => {
    useFileSession.setState({ text: "mine" });
    const leaving = ensureFileCanChangeWorkspace("/other");
    expect(useFileSession.getState().leavePrompt).toBe(true);
    await answerFileLeave("cancel");
    expect(await leaving).toBe(false);
    expect(useFileSession.getState().text).toBe("mine");
  });
  it("uses configured recovery when the file is clean", () => {
    expect(fileWorkspaceForRecovery("/configured")).toBe("/configured");
  });
  it("cancels navigation without discarding content", async () => {
    useFileSession.setState({ text: "mine" });
    const leaving = ensureFileCanLeave();
    expect(useFileSession.getState().leavePrompt).toBe(true);
    await answerFileLeave("cancel");
    expect(await leaving).toBe(false);
    expect(useFileSession.getState().text).toBe("mine");
  });
  it("discards explicitly and allows navigation", async () => {
    useFileSession.setState({ text: "mine" });
    const leaving = ensureFileCanLeave();
    await answerFileLeave("discard");
    expect(await leaving).toBe(true);
    expect(fileIsDirty()).toBe(false);
  });
  it("blocks navigation after a failed save", async () => {
    useFileSession.setState({ text: "mine" });
    request.mockRejectedValueOnce(new Error("disk full"));
    const leaving = ensureFileCanLeave();
    await answerFileLeave("save");
    expect(await leaving).toBe(false);
    expect(fileIsDirty()).toBe(true);
  });
  it("only navigates after successful save", async () => {
    useFileSession.setState({ text: "mine" });
    request.mockResolvedValueOnce(response(file("mine")));
    const leaving = ensureFileCanLeave();
    await answerFileLeave("save");
    expect(await leaving).toBe(true);
    expect(fileIsDirty()).toBe(false);
  });
});
