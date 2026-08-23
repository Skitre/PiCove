import { MAX_EXTENSION_UI_FLOATS } from "@pideck/protocol";
import { canonicalExtensionUiSettings } from "./desktop-settings";
import {
  buildExtensionPresentationSlots,
  countLiveFloatMounts,
  type ExtensionPresentationSlot,
  type LiveCustomContent,
  type LiveStatusContent,
  type LiveWidgetContent,
} from "./extension-ui-slots";
import { extensionUiRawLiveKey, useAppStore } from "./stores/app-store";

export function useLiveExtensionPresentationSlots(): ExtensionPresentationSlot[] {
  useAppStore((state) => state.extensionWidgets);
  useAppStore((state) => state.extensionStatuses);
  useAppStore((state) => state.extensionStatusOrigins);
  useAppStore((state) => state.extensionTerminal);
  useAppStore((state) => state.desktopSettings);
  return liveExtensionPresentationSlots();
}

export function liveExtensionPresentationSlots(): ExtensionPresentationSlot[] {
  const state = useAppStore.getState();
  const widgets: LiveWidgetContent[] = Object.values(state.extensionWidgets).map((widget) => ({
    key: widget.key,
    storageKey: widget.storageKey,
    widget: widget.widget,
    placement: widget.placement,
    origin: widget.origin,
  }));
  const statuses: LiveStatusContent[] = Object.entries(state.extensionStatuses).map(
    ([key, text]) => ({
      key: extensionUiRawLiveKey(key),
      text,
      origin: state.extensionStatusOrigins[key],
    }),
  );
  const custom: LiveCustomContent | null = state.extensionTerminal
    ? {
        requestId: state.extensionTerminal.requestId,
        title: state.extensionTerminal.title,
        origin: state.extensionTerminal.origin,
        overlay: state.extensionTerminal.overlay,
      }
    : null;
  return buildExtensionPresentationSlots({
    settings: canonicalExtensionUiSettings(state.desktopSettings),
    widgets,
    statuses,
    custom,
  });
}

/** One guard shared by every interaction that can create a new live Float. */
export function canCreateLiveExtensionFloat(slotId: string): boolean {
  const slots = liveExtensionPresentationSlots();
  const current = slots.find((slot) => slot.slotId === slotId);
  if (current?.mounts.some((mount) => mount.home.kind === "float")) return true;
  return countLiveFloatMounts(slots) < MAX_EXTENSION_UI_FLOATS;
}
