import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "./bridge/host-client";
import { dispatchExtensionWidgetAction } from "./extension-widget-action";
import { useAppStore } from "./stores/app-store";

beforeEach(() => {
  useAppStore.setState({
    host: {
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 3,
      sessionId: "s1",
      sessionRevision: 5,
    } as never,
    workspace: { id: "w1", revision: 3 } as never,
    session: { sessionId: "s1", revision: 5 } as never,
    surfaceLanguage: "en",
    desktopSettings: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ host: null, workspace: null, session: null });
});

describe("dispatchExtensionWidgetAction", () => {
  it("uses the current active Session identity", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { accepted: true },
    } as never);

    await expect(dispatchExtensionWidgetAction("fleet", "retry")).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith(
      "extensionUi.widgetAction",
      {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w1",
        expectedWorkspaceRevision: 3,
        expectedSessionId: "s1",
        expectedSessionRevision: 5,
      },
      { key: "fleet", actionId: "retry" },
    );
  });

  it("returns Host and transport failures for the renderer to report", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValueOnce({
      ok: false,
      error: { message: "Action is stale" },
    } as never);
    await expect(dispatchExtensionWidgetAction("fleet", "retry")).resolves.toBe("Action is stale");

    vi.spyOn(hostClient, "request").mockRejectedValueOnce(new Error("Host unavailable"));
    await expect(dispatchExtensionWidgetAction("fleet", "retry")).resolves.toBe("Host unavailable");
  });

  it("does not send without a live Session", async () => {
    useAppStore.setState({ session: null });
    const request = vi.spyOn(hostClient, "request");
    await expect(dispatchExtensionWidgetAction("fleet", "retry")).resolves.toBe(
      "Extension action is no longer available",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
