import { useId, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  parseStructuredWidget,
  type StructuredWidget,
  type StructuredWidgetAction,
  type StructuredWidgetTone,
} from "@pideck/protocol";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { statusChipText } from "../../lib/extension-ui-status-text";
import { stripAnsi } from "../../lib/strip-ansi";
import type { ExtensionRendererForm } from "../../lib/extension-ui-renderer-form";
import type { LiveWidgetContent } from "../../lib/extension-ui-slots";

export type ExtensionWidgetActionDispatch = (
  key: string,
  actionId: string,
) => Promise<string | null>;

function renderWidget(widget: unknown): string {
  if (typeof widget === "string") return widget;
  if (typeof widget === "number" || typeof widget === "boolean") return String(widget);
  if (Array.isArray(widget) && widget.every((line) => typeof line === "string")) {
    return widget.join("\n");
  }
  return JSON.stringify(widget, null, 2);
}

function widgetSummary(widget: unknown): string {
  const firstLine = stripAnsi(renderWidget(widget))
    .split("\n")
    .find((line) => line.trim() !== "");
  return firstLine ? firstLine.trim() : "";
}

function structuredWidgetSummary(widget: StructuredWidget): string {
  for (const row of widget.rows) {
    if (row.kind === "text") return row.text.split("\n")[0]?.trim() ?? "";
    if (row.kind === "fields" && row.fields[0]) {
      return `${row.fields[0].label}: ${row.fields[0].value}`;
    }
    if (row.kind === "progress") return row.label ?? `${row.value} / ${row.max}`;
    if (row.kind === "actions" && row.actions[0]) return row.actions[0].label;
  }
  return "";
}

function isPrimitiveValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function primitiveWidgetEntries(widget: unknown): Array<[string, string]> | null {
  if (typeof widget !== "object" || widget === null || Array.isArray(widget)) return null;
  const entries = Object.entries(widget);
  if (entries.length === 0) return null;
  const rows: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    if (!isPrimitiveValue(value)) return null;
    rows.push([key, String(value)]);
  }
  return rows;
}

function PanelWidgetBody({ widget }: { widget: unknown }) {
  if (typeof widget === "string") {
    return (
      <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
        {stripAnsi(widget)}
      </div>
    );
  }
  if (Array.isArray(widget) && widget.every((line) => typeof line === "string")) {
    return (
      <div className="flex flex-col font-mono text-xs text-foreground">
        {widget.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap break-words">
            {stripAnsi(line)}
          </div>
        ))}
      </div>
    );
  }
  const entries = primitiveWidgetEntries(widget);
  if (entries) {
    return (
      <dl className="flex flex-col gap-0.5 font-mono text-xs">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="shrink-0 text-muted">{key}</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <pre
      tabIndex={-1}
      aria-readonly="true"
      className="whitespace-pre-wrap break-words font-mono text-xs text-foreground"
    >
      {stripAnsi(renderWidget(widget))}
    </pre>
  );
}

const STRUCTURED_TEXT_TONE: Record<StructuredWidgetTone, string> = {
  default: "text-foreground",
  muted: "text-muted",
  warning: "text-warning",
  danger: "text-danger",
};

function structuredActionClass(action: StructuredWidgetAction): string {
  if (action.style === "primary") return primaryButton;
  if (action.style === "danger") {
    return `${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`;
  }
  return secondaryButton;
}

function StructuredWidgetBody({
  widget,
  widgetKey,
  onAction,
}: {
  widget: StructuredWidget;
  widgetKey: string;
  onAction?: ExtensionWidgetActionDispatch;
}) {
  const t = useT();
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<StructuredWidgetAction | null>(null);

  const runAction = async (action: StructuredWidgetAction) => {
    if (!onAction || action.disabled || pendingActionId !== null) return;
    setPendingActionId(action.id);
    try {
      const error = await onAction(widgetKey, action.id);
      if (error) pushNotification(error, "error");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("extensionWidgetActionFailed"),
        "error",
      );
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-xs" data-extension-structured-widget>
      {widget.rows.map((row, rowIndex) => {
        if (row.kind === "text") {
          return (
            <p
              key={rowIndex}
              className={`whitespace-pre-wrap break-words ${STRUCTURED_TEXT_TONE[row.tone ?? "default"]}`}
            >
              {row.text}
            </p>
          );
        }
        if (row.kind === "fields") {
          return (
            <dl
              key={rowIndex}
              className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1"
            >
              {row.fields.map((field, fieldIndex) => (
                <div key={`${field.label}:${fieldIndex}`} className="contents">
                  <dt className="truncate text-muted" title={field.label}>
                    {field.label}
                  </dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          );
        }
        if (row.kind === "progress") {
          const percent = (row.value / row.max) * 100;
          const label = row.label ?? `${row.value} / ${row.max}`;
          return (
            <div key={rowIndex} className="flex flex-col gap-1">
              {row.label ? (
                <div className="flex items-center justify-between gap-2 text-muted">
                  <span className="truncate">{row.label}</span>
                  <span className="shrink-0 font-mono">
                    {row.value} / {row.max}
                  </span>
                </div>
              ) : null}
              <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={row.max}
                aria-valuenow={row.value}
                className="h-1.5 overflow-hidden rounded-full bg-surface-overlay"
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
            </div>
          );
        }
        return (
          <div key={rowIndex} className="flex flex-wrap items-center gap-2">
            {row.actions.map((action) => {
              const pending = pendingActionId === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  className={structuredActionClass(action)}
                  disabled={action.disabled || pendingActionId !== null || !onAction}
                  aria-busy={pending || undefined}
                  onClick={() => {
                    if (action.confirm) setConfirming(action);
                    else void runAction(action);
                  }}
                >
                  {pending ? (
                    <LoaderCircle
                      aria-hidden="true"
                      size={13}
                      className="animate-spin motion-reduce:animate-none"
                    />
                  ) : null}
                  {action.label}
                </button>
              );
            })}
          </div>
        );
      })}
      {confirming ? (
        <Dialog
          title={t("extensionWidgetActionConfirmTitle", { action: confirming.label })}
          confirmLabel={confirming.label}
          tone={confirming.style === "danger" ? "danger" : "default"}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const action = confirming;
            setConfirming(null);
            void runAction(action);
          }}
        >
          <p>{confirming.confirm}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

export function ExtensionWidgetRows({
  widgets,
  form,
  onAction,
}: {
  widgets: readonly LiveWidgetContent[];
  form: ExtensionRendererForm;
  onAction?: ExtensionWidgetActionDispatch;
}) {
  const t = useT();
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);
  const onToggleCollapsed = useAppStore((state) => state.toggleExtensionWidgetCollapsed);
  return (
    <div className="flex flex-col gap-1">
      {widgets.map((entry) => (
        <WidgetRow
          key={entry.storageKey ?? entry.key}
          entry={entry}
          form={form}
          onAction={onAction}
          collapsed={collapsedWidgetKeys[entry.storageKey ?? entry.key] === true}
          onToggle={() => onToggleCollapsed(entry.storageKey ?? entry.key)}
          label={t("extWidgetLabel", { key: entry.key })}
          toggleLabel={t(
            collapsedWidgetKeys[entry.storageKey ?? entry.key]
              ? "extWidgetExpand"
              : "extWidgetCollapse",
            { key: entry.key },
          )}
        />
      ))}
    </div>
  );
}

function WidgetRow({
  entry,
  form,
  onAction,
  collapsed,
  onToggle,
  label,
  toggleLabel,
}: {
  entry: LiveWidgetContent;
  form: ExtensionRendererForm;
  onAction?: ExtensionWidgetActionDispatch;
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  toggleLabel: string;
}) {
  const contentId = useId();
  const structured = parseStructuredWidget(entry.widget);
  const summary =
    form === "strip"
      ? structured
        ? structuredWidgetSummary(structured)
        : widgetSummary(entry.widget)
      : "";
  return (
    <section className={collapsed ? undefined : "py-0.5"} aria-label={label}>
      <button
        type="button"
        className={`group flex w-full items-center gap-1 rounded px-0.5 text-left transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${
          collapsed ? "h-5" : "min-h-6"
        }`}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={onToggle}
      >
        <ChevronRight
          aria-hidden="true"
          size={11}
          className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="min-w-0 shrink-0 truncate text-[10px] font-medium uppercase leading-none text-muted group-hover:text-foreground">
          {entry.key}
        </span>
        {collapsed && summary ? (
          <span
            data-extension-widget-summary
            className="min-w-0 flex-1 truncate text-[10px] leading-none text-muted"
            title={summary}
          >
            {summary}
          </span>
        ) : null}
      </button>
      {!collapsed && (
        <div id={contentId} className="mt-1 pl-5">
          {structured ? (
            <StructuredWidgetBody widget={structured} widgetKey={entry.key} onAction={onAction} />
          ) : form === "panel" ? (
            <PanelWidgetBody widget={entry.widget} />
          ) : (
            <pre
              tabIndex={-1}
              aria-readonly="true"
              className="whitespace-pre-wrap break-words font-mono text-xs text-foreground"
            >
              {renderWidget(entry.widget)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

export function ExtensionStatusRows({
  statuses,
  form,
}: {
  statuses: readonly { key: string; text: string }[];
  form: ExtensionRendererForm;
}) {
  if (form === "list") {
    return (
      <dl className="flex flex-col gap-1 text-xs">
        {statuses.map((entry) => (
          <div key={entry.key} className="flex gap-2">
            <dt className="shrink-0 text-muted">{entry.key}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">
              {entry.text}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
      {statuses.map((entry) => {
        const label = statusChipText(entry.key, entry.text);
        return (
          <span key={entry.key} className="min-w-0 max-w-[18rem] truncate" title={label}>
            {label}
          </span>
        );
      })}
    </div>
  );
}
