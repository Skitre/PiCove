/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentSnapshot,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { draftTargetFor } from "../../lib/draft-target";
import { useAppStore } from "../../lib/stores/app-store";
import { Composer } from "./Composer";
import { MenuHost } from "../../components/Menu";

const desktopMocks = vi.hoisted(() => ({
  pick: vi.fn(),
  isDesktop: vi.fn(),
  drop: null as null | ((event: { payload: { type: string; paths: string[] } }) => void),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof desktopMocks.drop) => {
      desktopMocks.drop = handler;
      return () => {
        desktopMocks.drop = null;
      };
    },
  }),
}));

vi.mock("../../lib/desktop-file-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/desktop-file-access")>();
  return {
    ...original,
    isDesktopRuntime: desktopMocks.isDesktop,
    pickDesktopAttachmentPaths: desktopMocks.pick,
  };
});

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";
const TEXT_ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "test",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function attachment(status: "parsing" | "ready"): AttachmentSnapshot {
  return {
    id: ATTACHMENT_ID,
    name: "manual.pdf",
    mediaType: "application/pdf",
    sizeBytes: 2 * 1024 * 1024,
    status,
    unit: "page",
    unitCount: 3,
    processedUnits: status === "ready" ? 3 : 1,
  };
}

function textAttachment(status: "parsing" | "ready" | "failed"): AttachmentSnapshot {
  return {
    id: TEXT_ATTACHMENT_ID,
    name: "pasted-text-20260730-144500-123.txt",
    mediaType: "text/plain",
    sizeBytes: 4096,
    status,
    unit: "chunk",
    unitCount: 1,
    processedUnits: status === "ready" ? 1 : 0,
    ...(status === "failed" ? { error: "text parser failed" } : {}),
  };
}

function pasteText(target: HTMLElement, text: string): boolean {
  return fireEvent.paste(target, {
    clipboardData: {
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

describe("Composer managed documents", () => {
  it("does not turn native font drops over Settings into chat attachments", async () => {
    desktopMocks.isDesktop.mockResolvedValue(true);
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    render(<Composer />);
    await waitFor(() => expect(desktopMocks.drop).not.toBeNull());
    useAppStore.getState().setPage("settings");
    request.mockClear();
    await act(async () => {
      desktopMocks.drop?.({ payload: { type: "drop", paths: ["/fonts/example.ttf"] } });
    });
    expect(request.mock.calls.some(([method]) => method === "attachment.create")).toBe(false);
    expect(screen.queryByText("example.ttf")).not.toBeInTheDocument();
    useAppStore.getState().setPage("chat");
  });
  beforeEach(() => {
    desktopMocks.pick.mockReset().mockResolvedValue(["/documents/manual.pdf"]);
    desktopMocks.isDesktop.mockReset().mockResolvedValue(false);
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it("refreshes parsing state, gates send, and submits only the attachment ID", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.create")
        return { ok: true, result: attachment("parsing") } as never;
      if (method === "attachment.get") return { ok: true, result: attachment("ready") } as never;
      if (method === "agent.prompt") return { ok: true, result: { accepted: true } } as never;
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);

    await user.click(screen.getByRole("button", { name: "Attach PDF, DOCX, image, or text file" }));
    expect(await screen.findByText("manual.pdf")).toBeVisible();
    expect(await screen.findByText(/3 pages/)).toBeVisible();

    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    expect(request).toHaveBeenCalledWith(
      "agent.prompt",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      { text: "", attachmentIds: [ATTACHMENT_ID] },
      null,
    );
  });

  it("converts one 4 KiB paste and sends only its managed attachment ID", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return { ok: true, result: textAttachment("parsing") } as never;
      }
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("ready") } as never;
      }
      if (method === "agent.prompt") return { ok: true, result: { accepted: true } } as never;
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Summarize the attachment");
    const pasted = "x".repeat(4096);

    expect(pasteText(textarea, pasted)).toBe(false);
    expect(textarea).toHaveValue("Summarize the attachment");
    expect(await screen.findByText(textAttachment("ready").name)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(request).toHaveBeenCalledWith(
      "attachment.createText",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      { text: pasted },
      120_000,
    );
    expect(request).toHaveBeenCalledWith(
      "agent.prompt",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      { text: "Summarize the attachment", attachmentIds: [TEXT_ATTACHMENT_ID] },
      null,
    );
    expect(
      request.mock.calls.some(
        ([method, , params]) =>
          method === "agent.prompt" && JSON.stringify(params).includes(pasted),
      ),
    ).toBe(false);
  });

  it("pastes small clipboard text as a managed attachment from the context menu", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return { ok: true, result: textAttachment("parsing") } as never;
      }
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("ready") } as never;
      }
      return { ok: true, result: null } as never;
    });
    const clipboardText = "Short clipboard note";
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue(clipboardText) },
    });
    render(
      <>
        <Composer />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole("textbox"), { clientX: 18, clientY: 24 });
    await user.click(await screen.findByRole("menuitem", { name: "Paste as attachment" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "attachment.createText",
        expect.objectContaining({ expectedSessionId: SESSION_ID }),
        { text: clipboardText },
        120_000,
      ),
    );
  });

  it("keeps smaller pastes inline and measures multibyte text in UTF-8 bytes", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return { ok: true, result: textAttachment("parsing") } as never;
      }
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("ready") } as never;
      }
      return { ok: true, result: null } as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");

    expect(pasteText(textarea, "x".repeat(4095))).toBe(true);
    expect(pasteText(textarea, "界".repeat(1365))).toBe(true);
    expect(request).not.toHaveBeenCalledWith(
      "attachment.createText",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    expect(pasteText(textarea, "界".repeat(1366))).toBe(false);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "attachment.createText",
        expect.anything(),
        { text: "界".repeat(1366) },
        120_000,
      ),
    );
  });

  it("does not convert manual typing or multiple smaller pastes", () => {
    const request = vi.spyOn(hostClient, "request");
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    const half = "x".repeat(2048);

    fireEvent.change(textarea, { target: { value: "m".repeat(4096) } });
    expect(textarea).toHaveValue("m".repeat(4096));

    fireEvent.change(textarea, { target: { value: "" } });
    expect(pasteText(textarea, half)).toBe(true);
    fireEvent.change(textarea, { target: { value: half } });
    expect(pasteText(textarea, half)).toBe(true);
    fireEvent.change(textarea, { target: { value: half + half } });

    expect(textarea).toHaveValue("x".repeat(4096));
    expect(request).not.toHaveBeenCalledWith(
      "attachment.createText",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("restores a converted paste at its original selection", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return { ok: true, result: textAttachment("parsing") } as never;
      }
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("ready") } as never;
      }
      if (method === "attachment.remove") {
        return {
          ok: true,
          result: { attachmentId: TEXT_ATTACHMENT_ID, removed: true },
        } as never;
      }
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(textarea, "Before After");
    textarea.setSelectionRange(7, 7);
    const pasted = "z".repeat(4096);
    expect(pasteText(textarea, pasted)).toBe(false);

    const restore = await screen.findByRole("button", {
      name: /Restore pasted-text-.*\.txt to the composer/u,
    });
    await user.click(restore);
    await waitFor(() => expect(textarea).toHaveValue(`Before ${pasted}After`));
    expect(screen.queryByText(textAttachment("ready").name)).not.toBeInTheDocument();
  });

  it("restores pasted text when attachment creation fails", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "text parser failed" },
        } as never;
      }
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Keep: ");
    const pasted = "q".repeat(4096);
    expect(pasteText(textarea, pasted)).toBe(false);

    await waitFor(() => expect(textarea).toHaveValue(`Keep: ${pasted}`));
    expect(screen.queryByText("pasted-text.txt")).not.toBeInTheDocument();
  });

  it("keeps send disabled while the TXT creation request is pending", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const create = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") return create as never;
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("ready") } as never;
      }
      return { ok: true, result: null } as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    expect(pasteText(textarea, "p".repeat(4096))).toBe(false);

    expect(await screen.findByText(/Saving pasted text/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => {
      resolveCreate?.({ ok: true, result: textAttachment("parsing") });
      await create;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  });

  it("restores pasted text when background parsing fails", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") {
        return { ok: true, result: textAttachment("parsing") } as never;
      }
      if (method === "attachment.get") {
        return { ok: true, result: textAttachment("failed") } as never;
      }
      if (method === "attachment.remove") {
        return {
          ok: true,
          result: { attachmentId: TEXT_ATTACHMENT_ID, removed: true },
        } as never;
      }
      return { ok: true, result: null } as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    const pasted = "r".repeat(4096);
    expect(pasteText(textarea, pasted)).toBe(false);

    await waitFor(() => expect(textarea).toHaveValue(pasted));
    expect(screen.queryByText(textAttachment("failed").name)).not.toBeInTheDocument();
  });

  it("cleans a late TXT response after switching sessions", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const create = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "attachment.createText") return create as never;
      if (method === "attachment.remove") {
        return {
          ok: true,
          result: { attachmentId: TEXT_ATTACHMENT_ID, removed: true },
        } as never;
      }
      return { ok: true, result: null } as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    expect(pasteText(textarea, "s".repeat(4096))).toBe(false);
    expect(await screen.findByText("pasted-text.txt")).toBeVisible();

    act(() => {
      useAppStore.getState().setHost({
        ...host(),
        sessionId: NEXT_SESSION_ID,
        sessionRevision: 4,
      });
      useAppStore.getState().applySessionSnapshot({
        ...session(),
        sessionId: NEXT_SESSION_ID,
        revision: 4,
      });
      const target = draftTargetFor(workspace(), {
        ...session(),
        sessionId: NEXT_SESSION_ID,
      });
      if (target) useAppStore.getState().setDraftTextLocal(target, "New session draft");
    });
    await act(async () => {
      resolveCreate?.({ ok: true, result: textAttachment("parsing") });
      await create;
    });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "attachment.remove",
        expect.objectContaining({ expectedSessionId: SESSION_ID }),
        { attachmentId: TEXT_ATTACHMENT_ID },
      ),
    );
    expect(screen.getByRole("textbox")).toHaveValue("New session draft");
    expect(screen.queryByText(textAttachment("parsing").name)).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith(
      "attachment.get",
      expect.anything(),
      expect.anything(),
    );
  });

  it("blocks a paste larger than 1 MiB without changing the draft", async () => {
    const request = vi.spyOn(hostClient, "request");
    const user = userEvent.setup();
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Keep this draft");

    expect(pasteText(textarea, "x".repeat(1024 * 1024 + 1))).toBe(false);
    expect(textarea).toHaveValue("Keep this draft");
    expect(request).not.toHaveBeenCalled();
  });

  it("prioritizes clipboard files over a long text representation", async () => {
    const request = vi.spyOn(hostClient, "request");
    render(<Composer />);
    const textarea = screen.getByRole("textbox");
    const file = new File(["small note"], "note.txt", { type: "text/plain" });

    expect(
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ kind: "file", getAsFile: () => file }],
          getData: () => "x".repeat(4096),
        },
      }),
    ).toBe(false);
    expect(await screen.findByText("note.txt")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not reopen command completion after its token disappears", async () => {
    let resolveCommands: ((value: unknown) => void) | undefined;
    const commandRequest = new Promise((resolve) => {
      resolveCommands = resolve;
    });
    let commandRequests = 0;
    const request = vi.spyOn(hostClient, "request").mockImplementation((method) => {
      if (method === "session.getCommands") {
        commandRequests += 1;
        if (commandRequests === 1) return commandRequest as never;
        return Promise.resolve({
          ok: true,
          result: {
            commands: [
              {
                invocation: "fresh-command",
                description: "current request",
                kind: "command",
              },
            ],
          },
        }) as never;
      }
      return Promise.resolve({ ok: true, result: null }) as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");

    fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
    expect(request).toHaveBeenCalledWith(
      "session.getCommands",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      null,
    );
    fireEvent.change(textarea, { target: { value: "plain text", selectionStart: 10 } });
    await act(async () => {
      resolveCommands?.({
        ok: true,
        result: {
          commands: [
            {
              invocation: "late-command",
              description: "must stay closed",
              kind: "command",
            },
          ],
        },
      });
      await commandRequest;
    });

    expect(screen.queryByText("/late-command")).not.toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
    expect(await screen.findByText("/fresh-command")).toBeVisible();
    expect(commandRequests).toBe(2);
  });

  it("does not reopen file completion after its token disappears", async () => {
    let resolveFiles: ((value: unknown) => void) | undefined;
    const fileRequest = new Promise((resolve) => {
      resolveFiles = resolve;
    });
    let fileRequests = 0;
    const request = vi.spyOn(hostClient, "request").mockImplementation((method) => {
      if (method === "workspace.searchFiles") {
        fileRequests += 1;
        if (fileRequests === 1) return fileRequest as never;
        return Promise.resolve({
          ok: true,
          result: {
            files: [{ path: "src/fresh.ts", kind: "file" }],
            truncated: false,
          },
        }) as never;
      }
      return Promise.resolve({ ok: true, result: null }) as never;
    });
    render(<Composer />);
    const textarea = screen.getByRole("textbox");

    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
    expect(request).toHaveBeenCalledWith(
      "workspace.searchFiles",
      {
        expectedHostInstanceId: HOST_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedWorkspaceRevision: 1,
      },
      { query: "", limit: 3000 },
    );
    fireEvent.change(textarea, { target: { value: "plain text", selectionStart: 10 } });
    await act(async () => {
      resolveFiles?.({
        ok: true,
        result: { files: [{ path: "src/late.ts", kind: "file" }], truncated: false },
      });
      await fileRequest;
    });

    expect(screen.queryByText("src/late.ts")).not.toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
    expect(await screen.findByText("src/fresh.ts")).toBeVisible();
    expect(fileRequests).toBe(2);
  });
});
