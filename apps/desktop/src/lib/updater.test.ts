import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { checkForAppUpdate } from "./updater";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  mocks.isTauri.mockReset().mockReturnValue(true);
  mocks.check.mockReset();
  mocks.relaunch.mockReset();
  mocks.invoke.mockReset();
});

describe("checkForAppUpdate", () => {
  it("stays null in the browser mock without touching the updater plugin", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(checkForAppUpdate()).resolves.toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("maps no available update to null", async () => {
    mocks.check.mockResolvedValue(null);
    await expect(checkForAppUpdate()).resolves.toBeNull();
  });

  it("returns the update version and installs download-then-relaunch in order", async () => {
    const order: string[] = [];
    const downloadAndInstall = vi.fn(async () => {
      order.push("download");
    });
    mocks.relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    mocks.check.mockResolvedValue({ version: "0.2.0", downloadAndInstall });

    const update = await checkForAppUpdate();
    expect(update?.version).toBe("0.2.0");

    await update!.install();
    expect(order).toEqual(["download", "relaunch"]);
  });

  it("does not relaunch when the download fails", async () => {
    const downloadAndInstall = vi.fn(async () => {
      throw new Error("network gone");
    });
    mocks.check.mockResolvedValue({ version: "0.2.0", downloadAndInstall });

    const update = await checkForAppUpdate();
    await expect(update!.install()).rejects.toThrow("network gone");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("restores exit protection if relaunch fails", async () => {
    mocks.check.mockResolvedValue({ version: "0.2.0", downloadAndInstall: vi.fn() });
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    const update = await checkForAppUpdate();
    await expect(update!.install()).rejects.toThrow("restart failed");
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop_allow_exit", { approved: true }],
      ["desktop_allow_exit", { approved: false }],
    ]);
  });

  it("reports accumulated download progress before the install phase", async () => {
    const downloadAndInstall = vi.fn(async (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
      onEvent?.({ event: "Finished" });
    });
    mocks.check.mockResolvedValue({ version: "0.2.0", downloadAndInstall });

    const update = await checkForAppUpdate();
    const progress = vi.fn();
    await update!.install(progress);

    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { phase: "downloading", downloadedBytes: 0, totalBytes: 100 },
      { phase: "downloading", downloadedBytes: 25, totalBytes: 100 },
      { phase: "downloading", downloadedBytes: 50, totalBytes: 100 },
      { phase: "installing" },
    ]);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps progress indeterminate when the server omits content length", async () => {
    const downloadAndInstall = vi.fn(async (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: {} });
      onEvent?.({ event: "Progress", data: { chunkLength: 20 } });
    });
    mocks.check.mockResolvedValue({ version: "0.2.0", downloadAndInstall });

    const update = await checkForAppUpdate();
    const progress = vi.fn();
    await update!.install(progress);

    expect(progress).toHaveBeenLastCalledWith({
      phase: "downloading",
      downloadedBytes: 20,
      totalBytes: null,
    });
  });

  it("shares one in-flight plugin request across concurrent checks, then re-checks", async () => {
    let release!: (value: null) => void;
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = checkForAppUpdate();
    const second = checkForAppUpdate();
    release(null);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(mocks.check).toHaveBeenCalledTimes(1);

    mocks.check.mockResolvedValue(null);
    await checkForAppUpdate();
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("recovers after a failed check instead of caching the rejection", async () => {
    mocks.check.mockRejectedValueOnce(new Error("feed unreachable"));
    await expect(checkForAppUpdate()).rejects.toThrow("feed unreachable");

    mocks.check.mockResolvedValue(null);
    await expect(checkForAppUpdate()).resolves.toBeNull();
  });
});
