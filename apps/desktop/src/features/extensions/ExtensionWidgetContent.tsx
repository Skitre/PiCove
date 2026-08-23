import { useId } from "react";
import { ChevronRight } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { statusChipText } from "../../lib/extension-ui-status-text";
import { stripAnsi } from "../../lib/strip-ansi";
import type { ExtensionRendererForm } from "../../lib/extension-ui-renderer-form";
import type { LiveWidgetContent } from "../../lib/extension-ui-slots";

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

export function ExtensionWidgetRows({
  widgets,
  form,
}: {
  widgets: readonly LiveWidgetContent[];
  form: ExtensionRendererForm;
}) {
  const t = useT();
  const collapsedWidgetKeys = useAppStore((state) => state.collapsedExtensionWidgetKeys);
  const onToggleCollapsed = useAppStore((state) => state.toggleExtensionWidgetCollapsed);
  return (
    <div className="flex flex-col gap-1">
      {widgets.map((entry) => (
        <WidgetRow
          key={entry.key}
          entry={entry}
          form={form}
          collapsed={collapsedWidgetKeys[entry.key] === true}
          onToggle={() => onToggleCollapsed(entry.key)}
          label={t("extWidgetLabel", { key: entry.key })}
          toggleLabel={t(collapsedWidgetKeys[entry.key] ? "extWidgetExpand" : "extWidgetCollapse", {
            key: entry.key,
          })}
        />
      ))}
    </div>
  );
}

function WidgetRow({
  entry,
  form,
  collapsed,
  onToggle,
  label,
  toggleLabel,
}: {
  entry: LiveWidgetContent;
  form: ExtensionRendererForm;
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  toggleLabel: string;
}) {
  const contentId = useId();
  const summary = form === "strip" ? widgetSummary(entry.widget) : "";
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
          {form === "panel" ? (
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
