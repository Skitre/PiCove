import type { PresentationHome } from "@pideck/protocol";
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
} from "../../lib/extension-ui-presentation";
import { commitExtensionPresentationHome } from "../../lib/extension-ui-profile";
import type { Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

export type ExtensionSlotMenuFamily = "widget" | "status" | "custom";

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
    if (choice === currentChoice) continue;
    if (choice === "hidden" && family !== "widget") continue;
    const home = presentationHomeFromChoice(family, choice, settings, currentHome);
    items.push({
      id: `extension-home-${choice}`,
      label: t(extensionUiChoiceMessageKey(choice)),
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
    items,
  });
}
