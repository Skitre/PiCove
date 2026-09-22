import { describe, expect, it, vi } from "vitest";
import {
  closeWindowAfterDraftFlush,
  handleWindowClose,
  shouldHideWindowOnClose,
} from "./DraftPersistenceController";

describe("shouldHideWindowOnClose", () => {
  it.each(["windows", "win32", "macos", "darwin"])(
    "keeps the application alive on %s",
    (platform) => expect(shouldHideWindowOnClose(platform, "Linux")).toBe(true),
  );

  it("destroys Linux windows using the native platform metadata", () => {
    expect(shouldHideWindowOnClose("linux", "Macintosh")).toBe(false);
  });

  it("uses the user agent when Tauri platform metadata is unavailable", () => {
    expect(shouldHideWindowOnClose(undefined, "Windows NT 10.0")).toBe(true);
    expect(shouldHideWindowOnClose(undefined, "Macintosh")).toBe(true);
    expect(shouldHideWindowOnClose(undefined, "Linux")).toBe(false);
  });
});

describe("handleWindowClose", () => {
  it.each(["darwin", "windows"])(
    "settles drafts and hides without destroying the window on %s",
    async (platform) => {
      const calls: string[] = [];
      const appWindow = {
        hide: vi.fn(async () => {
          calls.push("hide");
        }),
        destroy: vi.fn(async () => {}),
      };
      await handleWindowClose({ preventDefault: () => calls.push("prevent") }, appWindow, {
        hideOnClose: shouldHideWindowOnClose(platform),
        settleDraftWrites: async () => {
          calls.push("settle");
        },
        ensureCanLeave: async () => {
          calls.push("confirm");
          return true;
        },
      });
      expect(calls).toEqual(["prevent", "settle", "confirm", "hide"]);
      expect(appWindow.destroy).not.toHaveBeenCalled();
    },
  );

  it("keeps the window visible when leaving an unsaved file is cancelled", async () => {
    const appWindow = { hide: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    await handleWindowClose({ preventDefault: vi.fn() }, appWindow, {
      hideOnClose: true,
      settleDraftWrites: async () => {},
      ensureCanLeave: async () => false,
    });
    expect(appWindow.hide).not.toHaveBeenCalled();
    expect(appWindow.destroy).not.toHaveBeenCalled();
  });

  it("surfaces a hide failure without destroying the retained window", async () => {
    const error = new Error("hide failed");
    const appWindow = {
      hide: vi.fn(async () => {
        throw error;
      }),
      destroy: vi.fn(async () => {}),
    };
    await expect(
      handleWindowClose({ preventDefault: vi.fn() }, appWindow, {
        hideOnClose: true,
        settleDraftWrites: async () => {},
        ensureCanLeave: async () => true,
      }),
    ).rejects.toThrow(error);
    expect(appWindow.destroy).not.toHaveBeenCalled();
  });
});

describe("closeWindowAfterDraftFlush", () => {
  it("hides the window before settling drafts and destroying it", async () => {
    const calls: string[] = [];

    await closeWindowAfterDraftFlush(
      { preventDefault: () => calls.push("prevent") },
      {
        hide: async () => {
          calls.push("hide");
        },
        destroy: async () => {
          calls.push("destroy");
        },
      },
      async () => {
        calls.push("settle");
      },
    );

    expect(calls).toEqual(["prevent", "hide", "settle", "destroy"]);
  });

  it("still settles drafts and destroys the window when hiding fails", async () => {
    const calls: string[] = [];

    await closeWindowAfterDraftFlush(
      { preventDefault: () => calls.push("prevent") },
      {
        hide: async () => {
          calls.push("hide");
          throw new Error("hide failed");
        },
        destroy: async () => {
          calls.push("destroy");
        },
      },
      async () => {
        calls.push("settle");
      },
    );

    expect(calls).toEqual(["prevent", "hide", "settle", "destroy"]);
  });
});
