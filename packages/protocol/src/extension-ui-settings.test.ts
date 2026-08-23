import { describe, expect, it } from "vitest";
import {
  MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH,
  MAX_EXTENSION_UI_EXTENSION_ID_LENGTH,
  MAX_EXTENSION_UI_IDENTITIES,
  MAX_EXTENSION_UI_SETTINGS_BYTES,
} from "./limits.js";
import {
  DEFAULT_EXTENSION_UI_SETTINGS,
  isExtensionDialogPresentationOverrides,
  isExtensionUiSettings,
  isPresentationHomeForFamily,
  legalPresentationHomeKinds,
  projectExtensionDialogPresentationOverrides,
  sanitizeExtensionUiSettings,
  trustedExtensionId,
  utf8JsonBytes,
} from "./extension-ui-settings.js";
import { validateEventPayload, validateSuccessResult } from "./validate.js";

const TRUSTED_ORIGIN = {
  invocationKind: "tool" as const,
  extensionId: "ext_review",
  extensionDisplayName: "Review",
  sourceKind: "package" as const,
  toolName: "ask",
  toolCallId: "call-1",
};

describe("Extension Deck settings contract", () => {
  it("accepts the V1 default snapshot and legal family homes", () => {
    expect(isExtensionUiSettings(DEFAULT_EXTENSION_UI_SETTINGS)).toBe(true);
    expect(isPresentationHomeForFamily("widget", { kind: "followExtension" })).toBe(true);
    expect(isPresentationHomeForFamily("widget", { kind: "anchor", slot: "belowComposer" })).toBe(
      true,
    );
    expect(isPresentationHomeForFamily("status", { kind: "anchor", slot: "belowComposer" })).toBe(
      false,
    );
    expect(
      isPresentationHomeForFamily("status", {
        kind: "float",
        rect: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBe(false);
    expect(isPresentationHomeForFamily("custom", { kind: "hidden" })).toBe(false);
    expect(
      isPresentationHomeForFamily("blockingDialog", { kind: "dock", group: "primary", order: 0 }),
    ).toBe(false);
    expect(isPresentationHomeForFamily("blockingDialog", { kind: "followHost" })).toBe(true);
    expect(legalPresentationHomeKinds("status")).toEqual(["anchor", "dock", "hidden"]);
  });

  describe("detached Float placement", () => {
    const rect = { x: 0.2, y: 0.1, width: 320, height: 180 };
    const monitor = {
      name: "DELL U2419H",
      position: { x: 1512, y: 0 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    };
    const detached = { monitor, rect: { x: 1600, y: 120, width: 400, height: 300 } };
    const float = (extra: Record<string, unknown>) => ({ kind: "float", rect, ...extra });

    it("keeps `detached` optional so a V1 file still reads as an attached Float", () => {
      expect(isPresentationHomeForFamily("widget", float({}))).toBe(true);
      expect(isPresentationHomeForFamily("widget", float({ pinned: true }))).toBe(true);
    });

    it("accepts a well-formed placement for the families that may float", () => {
      expect(isPresentationHomeForFamily("widget", float({ detached }))).toBe(true);
      expect(isPresentationHomeForFamily("custom", float({ detached }))).toBe(true);
      expect(
        isPresentationHomeForFamily("widget", {
          ...float({ detached: { monitor: { ...monitor, name: undefined }, rect: detached.rect } }),
        }),
      ).toBe(true);
    });

    it("cannot smuggle a detached Float into a family that may not float", () => {
      expect(isPresentationHomeForFamily("status", float({ detached }))).toBe(false);
      expect(isPresentationHomeForFamily("blockingDialog", float({ detached }))).toBe(false);
    });

    it.each([
      ["missing monitor", { rect: detached.rect }],
      ["missing rect", { monitor }],
      ["unknown key", { ...detached, zIndex: 3 }],
      ["non-finite coordinate", { monitor, rect: { ...detached.rect, x: Number.NaN } }],
      ["coordinate past the bound", { monitor, rect: { ...detached.rect, x: 1e9 } }],
      ["window narrower than the minimum", { monitor, rect: { ...detached.rect, width: 4 } }],
      ["zero scale factor", { monitor: { ...monitor, scaleFactor: 0 }, rect: detached.rect }],
      ["absurd scale factor", { monitor: { ...monitor, scaleFactor: 99 }, rect: detached.rect }],
      ["empty monitor name", { monitor: { ...monitor, name: "" }, rect: detached.rect }],
      ["monitor without size", { monitor: { ...monitor, size: undefined }, rect: detached.rect }],
    ])("rejects a placement with a %s", (_label, badDetached) => {
      expect(isPresentationHomeForFamily("widget", float({ detached: badDetached }))).toBe(false);
    });

    it("drops only the offending family when a placement is corrupt", () => {
      const repaired = sanitizeExtensionUiSettings({
        version: 1,
        presentations: {
          ext_a: {
            widget: { home: float({ detached: { monitor, rect: { x: 0, y: 0 } } }) },
            status: { home: { kind: "dock", group: "primary", order: 1 } },
          },
        },
        dock: { direction: "row", secondaryEnabled: false },
        observedCapabilities: {},
      });
      expect(repaired.presentations.ext_a).toEqual({
        status: { home: { kind: "dock", group: "primary", order: 1 } },
      });
    });

    it("preserves a valid placement through sanitization", () => {
      const repaired = sanitizeExtensionUiSettings({
        version: 1,
        presentations: { ext_a: { widget: { home: float({ detached }) } } },
        dock: { direction: "row", secondaryEnabled: false },
        observedCapabilities: {},
      });
      expect(repaired.presentations.ext_a?.widget?.home).toEqual(float({ detached }));
    });
  });

  it("rejects oversized identity maps and unknown versions", () => {
    const tooMany: Record<string, { home: { kind: "followHost" } }> = {};
    for (let index = 0; index < MAX_EXTENSION_UI_IDENTITIES + 1; index += 1) {
      tooMany[`ext_${index}`] = { home: { kind: "followHost" } };
    }
    expect(
      isExtensionUiSettings({
        version: 1,
        presentations: Object.fromEntries(
          Object.entries(tooMany).map(([id, home]) => [id, { blockingDialog: home }]),
        ),
        dock: { direction: "row", secondaryEnabled: false },
        observedCapabilities: {},
      }),
    ).toBe(false);
    expect(
      isExtensionUiSettings({
        version: 2,
        presentations: {},
        dock: { direction: "row", secondaryEnabled: false },
        observedCapabilities: {},
      }),
    ).toBe(false);
    expect(isExtensionIdTooLong()).toBe(false);
  });

  it("sanitizes unknown versions and drops only illegal family entries", () => {
    expect(sanitizeExtensionUiSettings({ version: 2, presentations: { ext_a: {} } })).toEqual(
      DEFAULT_EXTENSION_UI_SETTINGS,
    );
    const repaired = sanitizeExtensionUiSettings({
      version: 1,
      presentations: {
        ext_a: {
          widget: { home: { kind: "float", rect: { x: 0.2, y: 0.1, width: 320, height: 180 } } },
          status: { home: { kind: "float", rect: { x: 0, y: 0, width: 1, height: 1 } } },
        },
        "": { widget: { home: { kind: "hidden" } } },
      },
      dock: { direction: "column", secondaryEnabled: true, sizes: [0.7, 0.3] },
      observedCapabilities: {
        ext_a: { families: ["widget", "widget", "status"], lastSeenAt: 10 },
        ext_unknown: { families: ["notify"], lastSeenAt: 1 },
      },
    });
    expect(repaired.presentations.ext_a).toEqual({
      widget: { home: { kind: "float", rect: { x: 0.2, y: 0.1, width: 320, height: 180 } } },
    });
    expect(repaired.presentations[""]).toBeUndefined();
    expect(repaired.observedCapabilities.ext_a).toEqual({
      families: ["widget", "status"],
      lastSeenAt: 10,
    });
  });

  it("keeps a trusted display name on observed capabilities and drops an oversized one", () => {
    const repaired = sanitizeExtensionUiSettings({
      version: 1,
      presentations: {},
      dock: { direction: "row", secondaryEnabled: false },
      observedCapabilities: {
        ext_a: {
          families: ["widget"],
          lastSeenAt: 10,
          displayName: "  @juicesharp/rpiv-todo  ",
        },
        ext_b: {
          families: ["status"],
          lastSeenAt: 11,
          displayName: "x".repeat(MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH + 1),
        },
      },
    });
    expect(repaired.observedCapabilities.ext_a).toEqual({
      families: ["widget"],
      lastSeenAt: 10,
      displayName: "@juicesharp/rpiv-todo",
    });
    expect(repaired.observedCapabilities.ext_b).toEqual({
      families: ["status"],
      lastSeenAt: 11,
    });
    expect(
      isExtensionUiSettings({
        version: 1,
        presentations: {},
        dock: { direction: "row", secondaryEnabled: false },
        observedCapabilities: {
          ext_a: {
            families: ["widget"],
            lastSeenAt: 10,
            displayName: "@juicesharp/rpiv-todo",
          },
        },
      }),
    ).toBe(true);
  });

  it("projects only blocking-dialog homes into Host overrides", () => {
    const overrides = projectExtensionDialogPresentationOverrides({
      version: 1,
      presentations: {
        ext_a: {
          widget: { home: { kind: "hidden" } },
          blockingDialog: { home: { kind: "inline" } },
        },
        ext_b: { custom: { home: { kind: "followExtension" } } },
      },
      dock: { direction: "row", secondaryEnabled: false },
      observedCapabilities: {},
    });
    expect(overrides).toEqual({ ext_a: "inline" });
  });

  it("rejects invalid override maps by exact preference, id, count, and size", () => {
    expect(isExtensionDialogPresentationOverrides({ ext_a: "inline" })).toBe(true);
    expect(isExtensionDialogPresentationOverrides({ ext_a: "dock" })).toBe(false);
    expect(isExtensionDialogPresentationOverrides({ "": "inline" })).toBe(false);
    expect(
      isExtensionDialogPresentationOverrides({
        ["x".repeat(MAX_EXTENSION_UI_EXTENSION_ID_LENGTH + 1)]: "modal",
      }),
    ).toBe(false);
    const tooMany: Record<string, "inline"> = {};
    for (let index = 0; index < MAX_EXTENSION_UI_IDENTITIES + 1; index += 1) {
      tooMany[`ext_${index}`] = "inline";
    }
    expect(isExtensionDialogPresentationOverrides(tooMany)).toBe(false);
    expect(utf8JsonBytes(DEFAULT_EXTENSION_UI_SETTINGS)).toBeLessThan(
      MAX_EXTENSION_UI_SETTINGS_BYTES,
    );
  });
});

describe("Extension Deck event contract", () => {
  it("accepts optional trusted origin and overlay on existing events", () => {
    expect(
      validateEventPayload("extensionUi.widgetChanged", {
        key: "fleet",
        widget: ["row"],
        placement: "belowEditor",
        origin: TRUSTED_ORIGIN,
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.statusChanged", {
        key: "slash",
        text: "ready",
        origin: TRUSTED_ORIGIN,
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.customStarted", {
        requestId: "00000000-0000-4000-8000-000000000005",
        cols: 80,
        rows: 24,
        origin: TRUSTED_ORIGIN,
        overlay: true,
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.customStarted", {
        requestId: "00000000-0000-4000-8000-000000000005",
        cols: 80,
        rows: 24,
        overlay: false,
      }).ok,
    ).toBe(true);
  });

  it("keeps missing optional origin/overlay legal and rejects extra or illegal fields", () => {
    expect(validateEventPayload("extensionUi.widgetChanged", { widget: null }).ok).toBe(true);
    expect(
      validateEventPayload("extensionUi.widgetChanged", {
        widget: null,
        origin: { invocationKind: "unknown", guessed: true },
      }).ok,
    ).toBe(false);
    expect(
      validateEventPayload("extensionUi.customStarted", {
        requestId: "00000000-0000-4000-8000-000000000005",
        cols: 80,
        rows: 24,
        overlay: "yes",
      }).ok,
    ).toBe(false);
  });

  it("accepts user-extension route reasons and configure override results", () => {
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: "00000000-0000-4000-8000-000000000005",
        kind: "confirm",
        presentation: "inline",
        routeReason: "user-extension-inline",
      }).ok,
    ).toBe(true);
    expect(
      validateEventPayload("extensionUi.request", {
        requestId: "00000000-0000-4000-8000-000000000005",
        kind: "confirm",
        presentation: "modal",
        routeReason: "user-extension-modal",
      }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("extensionUi.configure", {
        extensionDecisionPresentation: "auto",
        extensionDialogPresentationOverrides: { ext_review: "followHost" },
      }).ok,
    ).toBe(true);
    expect(
      validateSuccessResult("extensionUi.configure", {
        extensionDecisionPresentation: "auto",
      }).ok,
    ).toBe(true);
  });

  it("does not treat originless events as trusted identities", () => {
    expect(trustedExtensionId(undefined)).toBeUndefined();
    expect(trustedExtensionId({ invocationKind: "unknown" })).toBeUndefined();
    expect(trustedExtensionId(TRUSTED_ORIGIN)).toBe("ext_review");
  });
});

function isExtensionIdTooLong(): boolean {
  return isExtensionUiSettings({
    version: 1,
    presentations: {
      ["x".repeat(MAX_EXTENSION_UI_EXTENSION_ID_LENGTH + 1)]: {
        widget: { home: { kind: "hidden" } },
      },
    },
    dock: { direction: "row", secondaryEnabled: false },
    observedCapabilities: {},
  });
}
