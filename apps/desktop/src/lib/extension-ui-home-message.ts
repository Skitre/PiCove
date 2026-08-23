import type { ExtensionSurfaceFamily, PresentationHome } from "@pideck/protocol";
import type { MessageKey } from "./i18n";
import type { ExtensionUiPresentationChoice } from "./extension-ui-presentation";

export function extensionUiHomeMessageKey(home: PresentationHome): MessageKey {
  switch (home.kind) {
    case "dock":
      return "extensionUiMovedToDock";
    case "float":
      return "extensionUiMovedToFloat";
    case "hidden":
      return "extensionUiMovedToHidden";
    case "anchor":
      return home.slot === "belowComposer"
        ? "extensionUiMovedToAnchorBelow"
        : "extensionUiMovedToAnchorAbove";
    default:
      return "extensionUiChangedHome";
  }
}

export function extensionUiChoiceMessageKey(choice: ExtensionUiPresentationChoice): MessageKey {
  switch (choice) {
    case "followExtension":
      return "extensionUiHomeFollowExtension";
    case "followHost":
      return "extensionUiHomeFollowHost";
    case "aboveComposer":
      return "extensionUiHomeAboveComposer";
    case "belowComposer":
      return "extensionUiHomeBelowComposer";
    case "dockPrimary":
      return "extensionUiHomeDockPrimary";
    case "dockSecondary":
      return "extensionUiHomeDockSecondary";
    case "float":
      return "extensionUiHomeFloat";
    case "hidden":
      return "extensionUiHomeHidden";
    case "inline":
      return "extensionUiHomeInline";
    case "modal":
      return "extensionUiHomeModal";
  }
}

export function extensionUiFamilyMessageKey(family: ExtensionSurfaceFamily): MessageKey {
  switch (family) {
    case "widget":
      return "extensionUiFamilyWidget";
    case "status":
      return "extensionUiFamilyStatus";
    case "custom":
      return "extensionUiFamilyCustom";
    case "blockingDialog":
      return "extensionUiFamilyBlocking";
  }
}
