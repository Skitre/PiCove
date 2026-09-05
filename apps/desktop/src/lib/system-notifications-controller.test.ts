import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostEventEnvelope } from "@pideck/protocol";
import { SystemNotificationController } from "./system-notifications";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  onAction: vi.fn(),
  granted: vi.fn(async () => true),
  request: vi.fn(async () => "granted"),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  onAction: native.onAction,
  isPermissionGranted: native.granted,
  requestPermission: native.request,
}));
vi.mock("./i18n/use-t", () => ({ tCurrent: (key: string) => key }));

let controller: SystemNotificationController;
let attention: "foreground" | "background" = "background";
let enabled = true;
const end = (runId: string) =>
  ({
    event: "agent.event",
    hostInstanceId: "host",
    workspaceId: "workspace",
    sessionId: "session",
    workspaceRevision: 1,
    sessionRevision: 1,
    packageRevision: 1,
    protocolVersion: 1,
    sequence: 1,
    timestamp: 1,
    payload: { runId, event: { type: "agent_end", willRetry: false, messages: [] } },
  }) as HostEventEnvelope;

beforeEach(() => {
  vi.resetAllMocks();
  native.onAction.mockRejectedValue(new Error("Command registerListener not found"));
  native.granted.mockResolvedValue(true);
  native.request.mockResolvedValue("granted");
  attention = "background";
  enabled = true;
  controller = new SystemNotificationController({
    enabled: () => enabled,
    attention: () => attention,
    targetForSession: () => ({ workspaceId: "workspace", workspaceRevision: 1 }),
    openTarget: async () => {},
  });
});
afterEach(() => controller.dispose());

it("sends through the desktop command even when the plugin has no action listener", async () => {
  await controller.start();
  controller.observe(end("one"));
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("plugin:notification|notify", {
      options: expect.objectContaining({
        title: "systemNotificationTitle",
        body: "systemNotificationReady",
      }),
    }),
  );
});

it("continues delivering after a transient native send error", async () => {
  native.invoke.mockRejectedValueOnce(new Error("temporary native failure"));
  controller.observe(end("one"));
  controller.observe(end("two"));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
});

it("stops queued sends after the OS denies permission", async () => {
  native.granted.mockResolvedValue(false);
  native.request.mockResolvedValue("denied");
  controller.observe(end("one"));
  controller.observe(end("two"));
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
  expect(native.invoke).not.toHaveBeenCalled();
});

it("can ask again when permission remains undecided", async () => {
  native.granted.mockResolvedValue(false);
  native.request.mockResolvedValueOnce("default").mockResolvedValueOnce("granted");
  controller.observe(end("one"));
  controller.observe(end("two"));
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
  expect(native.request).toHaveBeenCalledTimes(2);
});

it.each(["foreground", "disabled", "disposed"] as const)(
  "drops a delayed send after becoming %s",
  async (reason) => {
    let finish!: (value: boolean) => void;
    native.granted.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    controller.observe(end("one"));
    await vi.waitFor(() => expect(native.granted).toHaveBeenCalledTimes(1));
    if (reason === "foreground") attention = "foreground";
    if (reason === "disabled") enabled = false;
    if (reason === "disposed") controller.dispose();
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.invoke).not.toHaveBeenCalled();
  },
);
