import type { PresentationHome } from "@pideck/protocol";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  EyeOff,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { contextMenuTrigger, openContextMenu, type MenuItem } from "../../lib/context-menu";
import {
  canonicalExtensionUiSettings,
  notifyDesktopSettingsSaveFailure,
} from "../../lib/desktop-settings";
import {
  extensionUiChoiceMessageKey,
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "../../lib/extension-ui-home-message";
import { observedExtensionDisplayName } from "../../lib/extension-ui-observation";
import {
  FAMILY_PRESENTATION_CHOICES,
  presentationChoiceFromHome,
  presentationHomeFromChoice,
  type ExtensionUiPresentationChoice,
} from "../../lib/extension-ui-presentation";
import { commitExtensionPresentationHome } from "../../lib/extension-ui-profile";
import { detachedHomeForViewportRect, type ViewportRect } from "../../lib/extension-float-detach";
import type { Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { canCreateLiveExtensionFloat } from "../../lib/extension-ui-live-slots";

export type ExtensionSlotMenuFamily = "widget" | "status" | "custom";

const PLACEMENT_ICONS: Partial<Record<ExtensionUiPresentationChoice, LucideIcon>> = {
  followExtension: RotateCcw,
  aboveComposer: ArrowUp,
  belowComposer: ArrowDown,
  dockPrimary: PanelRightOpen,
  dockSecondary: PanelRightClose,
  hidden: EyeOff,
};

function compactPlacementLabel(choice: ExtensionUiPresentationChoice, t: Translate): string {
  switch (choice) {
    case "followExtension":
      return t("extensionUiPlacementDefault");
    case "dockPrimary":
      return t("extensionUiPlacementDockPrimary");
    case "dockSecondary":
      return t("extensionUiPlacementDockSecondary");
    default:
      return t(extensionUiChoiceMessageKey(choice));
  }
}

/**
 * Open the legal-destinations context menu for one Extension presentation slot.
 * Moves persist through `commitExtensionPresentationHome`, so every choice comes
 * with the session-global Undo toast.
 */
export function openExtensionSlotContextMenu(input: {
  family: ExtensionSlotMenuFamily;
  extensionId: string | undefined;
  currentHome: PresentationHome;
  event: {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
    preventDefault(): void;
  };
  t: Translate;
}): void {
  input.event.preventDefault();
  const { family, extensionId, currentHome, t } = input;
  if (!extensionId) return;
  const settings = canonicalExtensionUiSettings(useAppStore.getState().desktopSettings);
  const name = observedExtensionDisplayName(extensionId);
  const familyLabel = t(extensionUiFamilyMessageKey(family));
  const currentChoice = presentationChoiceFromHome(family, currentHome);
  const items: MenuItem[] = [];
  for (const choice of FAMILY_PRESENTATION_CHOICES[family]) {
    if (choice === "hidden" && family !== "widget") continue;
    // A float is its own OS window now. `detachItems` offers that destination;
    // the in-window layer is only where a float lands when no window can be
    // opened for it, so it is not something to choose.
    if (choice === "float") continue;
    const home = presentationHomeFromChoice(family, choice, settings, currentHome);
    items.push({
      id: `extension-home-${choice}`,
      label: compactPlacementLabel(choice, t),
      icon: PLACEMENT_ICONS[choice],
      selected: choice === currentChoice,
      disabled: choice === currentChoice,
      onSelect: () => {
        void commitExtensionPresentationHome({
          extensionId,
          family,
          home,
          message: t(extensionUiHomeMessageKey(home), { name, family: familyLabel }),
        }).catch(notifyDesktopSettingsSaveFailure);
      },
    });
  }
  openContextMenu({
    x: input.event.clientX,
    y: input.event.clientY,
    trigger: contextMenuTrigger(input.event.target),
    density: "compact",
    items: [...items, ...detachItems(input, settings, name, familyLabel)],
  });
}

/**
 * "Move to its own window" is a container choice for a Float, not a new
 * presentation — so it is offered to exactly the families that may float, and
 * a slot that is not floating yet becomes a Float on the way out.
 *
 * A slot that is already detached has no item here: its own window carries the
 * reattach control, and the in-window layer does not draw it at all.
 */
function detachItems(
  input: Parameters<typeof openExtensionSlotContextMenu>[0],
  settings: ReturnType<typeof canonicalExtensionUiSettings>,
  name: string,
  familyLabel: string,
): MenuItem[] {
  const { family, extensionId, currentHome, t } = input;
  if (!extensionId) return [];
  if (family !== "widget" && family !== "custom") return [];
  if (currentHome.kind === "float" && currentHome.detached) return [];
  if (!canCreateLiveExtensionFloat(`${extensionId}:${family}`)) return [];
  const anchor = floatAnchorRect(input.event.target);
  return [
    {
      id: "extension-home-detach",
      label: t("extensionUiHomeFloat"),
      icon: ExternalLink,
      separatorBefore: true,
      onSelect: () => {
        void (async () => {
          const asFloat = presentationHomeFromChoice(family, "float", settings, currentHome);
          if (asFloat.kind !== "float") return;
          // No display can host it — commit the float anyway. The window
          // controller keeps trying, and until it succeeds the in-window layer
          // draws it, which beats a menu entry that silently does nothing.
          const home = (await detachedHomeForViewportRect(asFloat, anchor)) ?? asFloat;
          await commitExtensionPresentationHome({
            extensionId,
            family,
            home,
            message: t("extensionUiMovedToDetached", { name, family: familyLabel }),
          });
        })().catch(notifyDesktopSettingsSaveFailure);
      },
    },
  ];
}

/**
 * Where the slot is drawn right now, so its window opens over the same pixels.
 * Falls back to a readable default when the menu was opened from chrome that is
 * not the Float shell itself.
 */
function floatAnchorRect(target: EventTarget | null): ViewportRect {
  const element = target instanceof Element ? target.closest("[data-extension-float]") : null;
  if (element) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return { left: 80, top: 80, width: 360, height: 240 };
}
