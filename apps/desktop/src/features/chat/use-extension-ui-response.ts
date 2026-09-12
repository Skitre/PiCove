import type { JsonValue } from "@pideck/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostClient } from "../../lib/bridge/host-client";
import { latestSessionTargetContext } from "../../lib/bridge/host-context";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import {
  type ExtensionDecisionStepOutcome,
  isExtensionUiRequestExpired,
  type ExtensionUiRequestState,
} from "../../lib/stores/extension-ui-state";

export type ExtensionUiResponseController = {
  input: string;
  setInput: (value: string) => void;
  submitting: boolean;
  error: string | null;
  respond: (status: "resolved" | "cancelled", value?: JsonValue) => Promise<boolean>;
};

export function useExtensionUiResponse(
  request: ExtensionUiRequestState | null,
): ExtensionUiResponseController {
  const t = useT();
  const closeRequest = useAppStore((state) => state.closeExtensionUiRequest);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [input, setInputState] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;

  const clearIfCurrent = useCallback(
    (requestId: string, outcome: ExtensionDecisionStepOutcome): boolean => {
      if (useAppStore.getState().extensionUiRequest?.requestId !== requestId) return false;
      closeRequest(requestId, outcome);
      return true;
    },
    [closeRequest],
  );

  useEffect(() => {
    submittingRef.current = false;
    setInputState(request?.defaultValue ?? "");
    setSubmitting(false);
    setError(null);
  }, [request?.requestId, request?.defaultValue]);

  useEffect(() => {
    if (!request?.expiresAt) return;
    const requestId = request.requestId;
    const timer = window.setTimeout(
      () => {
        if (!clearIfCurrent(requestId, "expired")) return;
        pushNotification(t("extUiExpired"), "warning");
      },
      Math.max(0, request.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [request?.requestId, request?.expiresAt, clearIfCurrent, pushNotification, t]);

  const respond = useCallback(
    async (status: "resolved" | "cancelled", value?: JsonValue): Promise<boolean> => {
      if (!request || submittingRef.current) return false;
      if (isExtensionUiRequestExpired(request)) {
        if (clearIfCurrent(request.requestId, "expired")) {
          pushNotification(t("extUiExpired"), "warning");
        }
        return false;
      }

      const requestId = request.requestId;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const state = useAppStore.getState();
        const response = await hostClient.request(
          "extensionUi.respond",
          latestSessionTargetContext(request.context, state.host, state.workspace, state.session),
          { requestId, status, value },
        );
        if (!response.ok) {
          const details = response.error?.details;
          if (
            response.error?.code === "STALE_REVISION" &&
            details &&
            typeof details === "object" &&
            !Array.isArray(details) &&
            details.requestId === requestId &&
            details.requestClosed === true
          ) {
            if (clearIfCurrent(requestId, "stale")) {
              const current = useAppStore.getState();
              if (
                request.groupKey &&
                current.extensionDecisionGroups[request.groupKey]?.activeRequestId === null
              ) {
                current.closeExtensionDecisionGroup(request.groupKey, "stale");
              }
              pushNotification(t("extUiNoLongerActive"), "warning");
            }
            return false;
          }
          const message = response.error?.message ?? t("extUiRespondFailed");
          if (useAppStore.getState().extensionUiRequest?.requestId === requestId) {
            setError(message);
            pushNotification(message, "error");
          }
          return false;
        }
        clearIfCurrent(requestId, status === "resolved" ? "answered" : "cancelled");
        return true;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : t("extUiRespondFailed");
        if (useAppStore.getState().extensionUiRequest?.requestId === requestId) {
          setError(message);
          pushNotification(message, "error");
        }
        return false;
      } finally {
        if (requestRef.current?.requestId === requestId) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    },
    [request, clearIfCurrent, pushNotification, t],
  );

  const setInput = useCallback((value: string) => {
    setInputState(value);
    setError(null);
  }, []);

  return { input, setInput, submitting, error, respond };
}
