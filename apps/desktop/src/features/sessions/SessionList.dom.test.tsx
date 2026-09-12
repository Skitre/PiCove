/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostStatusSnapshot,
  SessionSnapshot,
  SessionSummary,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { MenuHost } from "../../components/Menu";
import { closeContextMenu } from "../../lib/context-menu";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SessionList } from "./SessionList";

const summary: SessionSummary = {
  sessionId: "session-1",
  sessionPath: "/sessions/session-1.jsonl",
  name: "Position the menu",
  cwd: "/workspace",
  updatedAt: 1,
  messageCount: 1,
};

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.84.2",
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

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: summary.sessionId,
    sessionPath: summary.sessionPath,
    name: summary.name,
    cwd: workspace.cwd,
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "Original request" }],
    tools: {
      revision: 1,
      workspaceId: workspace.id,
      sessionId: summary.sessionId,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

function deferGeneration() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((done, fail) => {
    resolve = (value) => done(value as never);
    reject = fail;
  });
  vi.mocked(hostClient.request).mockImplementation((method, _context, params) => {
    if (method === "session.generateTitle") return promise;
    if (method === "session.open") {
      const item = Object.values(useAppStore.getState().sessionCatalog.entries).find(
        (entry) => entry.sessionPath === (params as { sessionPath: string }).sessionPath,
      )!;
      return Promise.resolve({
        ok: true,
        result: snapshot({
          sessionId: item.sessionId,
          sessionPath: item.sessionPath,
          name: item.name,
          revision: 2,
        }),
      } as never);
    }
    if (method === "session.rename") {
      return Promise.resolve({
        ok: true,
        result: { sessionId: summary.sessionId, name: (params as { name: string }).name },
      } as never);
    }
    return Promise.resolve({
      ok: true,
      result: { items: Object.values(useAppStore.getState().sessionCatalog.entries) },
    } as never);
  });
  return { resolve, reject };
}

function startGeneration() {
  fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "AI generate title" }));
}

describe("SessionList menu", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
      workspaceSwitchTarget: null,
      notifications: [],
    });
    useAppStore.getState().clearSessionCatalog();
    useAppStore.getState().replaceSessionCatalog(workspace.id, [summary]);
    vi.spyOn(hostClient, "request").mockImplementation(
      async () =>
        ({
          ok: true,
          result: { items: Object.values(useAppStore.getState().sessionCatalog.entries) },
        }) as never,
    );
  });

  afterEach(() => {
    cleanup();
    closeContextMenu();
    vi.restoreAllMocks();
  });

  it("portals the fixed menu out of the transformed collapsible region", () => {
    render(<SessionList />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 186,
      y: 118,
      width: 22,
      height: 22,
      top: 118,
      right: 208,
      bottom: 140,
      left: 186,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = document.body.querySelector<HTMLElement>(
      ".theme-floating-surface[data-session-menu]",
    );
    expect(menu).not.toBeNull();
    expect(trigger.closest(".collapsible-region__content")).not.toBeNull();
    expect(menu?.closest(".collapsible-region__content")).toBeNull();
    expect(menu).toHaveStyle({ left: "32px", top: "144px" });
  });

  it("portals the delete confirm out of the clipped collapsible region", () => {
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Permanently delete Session?" });
    expect(dialog).toHaveAttribute("data-session-confirm");
    expect(dialog.closest(".collapsible-region__content")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("shows a running status without a stop control", () => {
    useAppStore.getState().replaceSessionCatalog(workspace.id, [
      {
        ...summary,
        runtimeState: "running",
        sessionRevision: 4,
      },
    ]);

    render(<SessionList />);

    expect(screen.getByLabelText("running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it.each(["context", "ellipsis"] as const)(
    "generates a title from the %s menu with pending feedback",
    async (menu) => {
      const completion = deferGeneration();
      render(
        <>
          <SessionList />
          <MenuHost />
        </>,
      );
      const openMenu = () => {
        if (menu === "context") fireEvent.contextMenu(screen.getByText(summary.name!));
        else fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
      };
      const role = menu === "context" ? "menuitem" : "button";
      openMenu();
      fireEvent.click(screen.getByRole(role, { name: "AI generate title" }));

      expect(screen.getByRole("status", { name: "Generating title…" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Position the menu/ })).toBeEnabled();
      openMenu();
      const pendingAction = screen.getByRole(role, { name: "Generating title…" });
      expect(pendingAction).toBeDisabled();
      fireEvent.click(pendingAction);
      expect(
        vi
          .mocked(hostClient.request)
          .mock.calls.filter(([method]) => method === "session.generateTitle"),
      ).toHaveLength(1);
      expect(hostClient.request).toHaveBeenCalledWith(
        "session.generateTitle",
        {
          expectedHostInstanceId: host.hostInstanceId,
          expectedWorkspaceId: workspace.id,
          expectedWorkspaceRevision: workspace.revision,
        },
        { sessionId: summary.sessionId, sessionPath: summary.sessionPath },
      );

      await act(async () =>
        completion.resolve({
          ok: true,
          result: { sessionId: summary.sessionId, name: "A useful title" },
        }),
      );
      expect(screen.getByText("A useful title")).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Generating title…" })).toBeNull();
    },
  );

  it.each(["response", "transport"])(
    "keeps the old title and clears pending state after a %s failure",
    async (failure) => {
      const completion = deferGeneration();
      render(<SessionList />);
      startGeneration();
      await act(async () => {
        if (failure === "response")
          completion.resolve({ ok: false, error: { message: "Provider unavailable" } });
        else completion.reject(new Error("Provider unavailable"));
      });
      expect(screen.getByText(summary.name!)).toBeInTheDocument();
      expect(screen.queryByRole("status")).toBeNull();
      expect(useAppStore.getState().notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Title generation failed: Provider unavailable",
            level: "error",
          }),
        ]),
      );
      fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
      expect(screen.getByRole("button", { name: "AI generate title" })).toBeEnabled();
    },
  );

  it("allows navigation and never applies the target snapshot to the newly opened session", async () => {
    const completion = deferGeneration();
    const other = {
      ...summary,
      sessionId: "session-2",
      sessionPath: "/sessions/2.jsonl",
      name: "Another conversation",
      updatedAt: 0,
    };
    useAppStore.getState().replaceSessionCatalog(workspace.id, [summary, other]);
    render(<SessionList />);
    startGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Another conversation" }));
    await waitFor(() => expect(useAppStore.getState().session?.sessionId).toBe(other.sessionId));
    const selected = useAppStore.getState().session;
    await act(async () =>
      completion.resolve({
        ok: true,
        result: {
          sessionId: summary.sessionId,
          name: "Generated title",
          session: snapshot({ name: "Generated title" }),
        },
      }),
    );
    expect(useAppStore.getState().session).toBe(selected);
    expect(useAppStore.getState().sessionCatalog.entries[summary.sessionId]?.name).toBe(
      "Generated title",
    );
  });

  it("updates only the active name and preserves newer messages", async () => {
    const completion = deferGeneration();
    const before = snapshot();
    useAppStore.setState({
      session: before,
      host: { ...host, sessionId: before.sessionId, sessionRevision: 1 },
    });
    render(<SessionList />);
    startGeneration();
    const messages = [...before.messages, { role: "assistant", content: "A newer answer" }];
    act(() => useAppStore.setState({ session: { ...before, messages } }));
    await act(async () =>
      completion.resolve({
        ok: true,
        result: {
          sessionId: summary.sessionId,
          name: "Generated title",
          session: { ...before, name: "Generated title" },
        },
      }),
    );
    expect(useAppStore.getState().session?.name).toBe("Generated title");
    expect(useAppStore.getState().session?.messages).toEqual(messages);
  });

  it("allows manual renaming while generating and preserves it over a late success response", async () => {
    const completion = deferGeneration();
    render(<SessionList />);
    startGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
      target: { value: "My own title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByText("My own title");
    await act(async () =>
      completion.resolve({
        ok: true,
        result: { sessionId: summary.sessionId, name: "Late AI title" },
      }),
    );
    expect(screen.getByText("My own title")).toBeInTheDocument();
  });

  it.each([true, false])(
    "ignores results after a workspace switch (success: %s)",
    async (success) => {
      const completion = deferGeneration();
      render(<SessionList />);
      startGeneration();
      act(() => {
        useAppStore.setState({
          workspace: { ...workspace, id: "workspace-2", revision: 2 },
          host: { ...host, workspaceId: "workspace-2", workspaceRevision: 2 },
        });
        useAppStore
          .getState()
          .replaceSessionCatalog("workspace-2", [{ ...summary, name: "Other workspace title" }]);
      });
      await act(async () =>
        completion.resolve(
          success
            ? { ok: true, result: { sessionId: summary.sessionId, name: "Late AI title" } }
            : { ok: false, error: { message: "Late provider failure" } },
        ),
      );
      expect(screen.getByText("Other workspace title")).toBeInTheDocument();
      expect(useAppStore.getState().notifications).toEqual([]);
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it.each(["empty", "running"])("disables generation for an %s conversation", (state) => {
    useAppStore.getState().replaceSessionCatalog(workspace.id, [
      {
        ...summary,
        ...(state === "empty" ? { messageCount: 0 } : { runtimeState: "running" as const }),
      },
    ]);
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("button", { name: "AI generate title" })).toBeDisabled();
  });
});
