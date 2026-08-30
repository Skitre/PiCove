import { hostClient } from "./bridge/host-client";
import { activeSessionContext } from "./bridge/host-context";
import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";

/** Dispatch from an in-window widget using the freshest active Session identity. */
export async function dispatchExtensionWidgetAction(
  key: string,
  actionId: string,
): Promise<string | null> {
  const { host, workspace, session } = useAppStore.getState();
  if (!host || !workspace || !session) return tCurrent("extensionWidgetActionUnavailable");
  try {
    const response = await hostClient.request(
      "extensionUi.widgetAction",
      activeSessionContext(host, workspace, session),
      { key, actionId },
    );
    return response.ok
      ? null
      : (response.error?.message ?? tCurrent("extensionWidgetActionFailed"));
  } catch (error) {
    return error instanceof Error ? error.message : tCurrent("extensionWidgetActionFailed");
  }
}
