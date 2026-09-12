import { Check, LoaderCircle } from "lucide-react";
import { useId } from "react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent } from "./ExtensionUiRequestContent";
import { useExtensionUiResponse } from "./use-extension-ui-response";

export function InlineExtensionUiRequest() {
  const t = useT();
  const activeRequest = useAppStore((state) => state.extensionUiRequest);
  const request = activeRequest?.presentation === "inline" ? activeRequest : null;
  const decisionGroups = useAppStore((state) => state.extensionDecisionGroups);
  const sessionId = useAppStore((state) => state.session?.sessionId ?? null);
  const requestGroup = request?.groupKey ? decisionGroups[request.groupKey] : undefined;
  const waitingGroup = activeRequest
    ? undefined
    : Object.values(decisionGroups)
        .filter(
          (group) =>
            group.status === "active" &&
            group.presentation === "inline" &&
            group.activeRequestId === null &&
            group.context.expectedSessionId === sessionId,
        )
        .at(-1);
  const group = requestGroup ?? waitingGroup;
  const controller = useExtensionUiResponse(request);
  const titleId = useId();

  if (!request && !group) return null;
  const answeredCount = group?.answeredCount ?? 0;
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="shrink-0 px-5 pt-2"
      data-extension-ui-surface="inline"
    >
      <div
        className={`conversation-content-width mx-auto max-h-[min(32rem,50dvh)] w-full overflow-y-auto overscroll-contain rounded-md border bg-surface-raised px-3.5 py-3 shadow-sm ${
          (request?.risk ?? group?.risk) === "high" ? "border-warning/40" : "border-border"
        }`}
        data-extension-ui-group={group?.groupKey}
      >
        {group && answeredCount > 0 ? (
          <div className="mb-3 flex min-h-6 items-center gap-1.5 border-b border-border pb-2 text-xs text-muted">
            <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            <span>{t("extUiGroupAnswered", { count: answeredCount })}</span>
          </div>
        ) : null}
        {request ? (
          <ExtensionUiRequestContent
            key={request.requestId}
            request={request}
            controller={controller}
            titleId={titleId}
            variant="inline"
          />
        ) : (
          <div
            id={titleId}
            className="flex min-h-20 items-center gap-2 text-sm text-muted"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle
              className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{t("extUiGroupWaiting")}</span>
          </div>
        )}
      </div>
    </section>
  );
}
