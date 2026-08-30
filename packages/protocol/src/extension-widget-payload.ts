import {
  MAX_STRUCTURED_WIDGET_ACTION_ID_LENGTH,
  MAX_STRUCTURED_WIDGET_ACTIONS,
  MAX_STRUCTURED_WIDGET_FIELDS,
  MAX_STRUCTURED_WIDGET_LABEL_LENGTH,
  MAX_STRUCTURED_WIDGET_ROWS,
  MAX_STRUCTURED_WIDGET_TEXT_LENGTH,
} from "./limits.js";

/**
 * The structured widget payload (extension-deck.md, "Structured widgets").
 *
 * `extensionUi.widgetChanged` already carries `widget: JsonValue`, so an
 * Extension opts in by publishing a payload that matches this shape. There is
 * no new event, no SDK release, and no change to how a widget is published,
 * aggregated, or placed.
 *
 * Anything that does not match — including a newer `pideck` version — is not an
 * error. It falls back to the read-only text renderers, so a widget published
 * for a later PiDeck still shows its content rather than an error card.
 *
 * Extensions ship semantic data only. `rows` describes meaning; PiDeck owns
 * every control, style, focus ring, and accessible name. Nothing here can carry
 * HTML, CSS, or renderer code.
 */

export const STRUCTURED_WIDGET_VERSION = 1;

export type StructuredWidgetTone = "default" | "muted" | "warning" | "danger";
export type StructuredWidgetActionStyle = "default" | "primary" | "danger";

export type StructuredWidgetAction = {
  id: string;
  label: string;
  style?: StructuredWidgetActionStyle;
  /** Host-rendered confirmation shown before the action is dispatched. */
  confirm?: string;
  disabled?: boolean;
};

export type StructuredWidgetRow =
  | { kind: "text"; text: string; tone?: StructuredWidgetTone }
  | { kind: "fields"; fields: { label: string; value: string }[] }
  | { kind: "progress"; value: number; max: number; label?: string }
  | { kind: "actions"; actions: StructuredWidgetAction[] };

export type StructuredWidget = {
  pideck: typeof STRUCTURED_WIDGET_VERSION;
  rows: StructuredWidgetRow[];
};

const TONES: readonly string[] = ["default", "muted", "warning", "danger"];
const ACTION_STYLES: readonly string[] = ["default", "primary", "danger"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) return false;
  return required.every((key) => keys.includes(key));
}

/** Bounded, non-empty, and free of the control characters a renderer must not meet. */
function isDisplayText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // Newlines survive: a text row is allowed to wrap. Everything else in the
    // control ranges is not display text.
    if (code === 0x0a) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/** An identifier the Extension will match on; never rendered, so no newlines. */
function isActionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRUCTURED_WIDGET_ACTION_ID_LENGTH &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function isProgressNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAction(value: unknown): value is StructuredWidgetAction {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, ["id", "label"], ["style", "confirm", "disabled"])) return false;
  if (!isActionId(value.id)) return false;
  if (!isDisplayText(value.label, MAX_STRUCTURED_WIDGET_LABEL_LENGTH)) return false;
  if (value.style !== undefined && !ACTION_STYLES.includes(value.style as string)) return false;
  if (
    value.confirm !== undefined &&
    !isDisplayText(value.confirm, MAX_STRUCTURED_WIDGET_TEXT_LENGTH)
  ) {
    return false;
  }
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return false;
  return true;
}

function isRow(value: unknown): value is StructuredWidgetRow {
  if (!isPlainObject(value)) return false;
  switch (value.kind) {
    case "text":
      return (
        hasExactKeys(value, ["kind", "text"], ["tone"]) &&
        isDisplayText(value.text, MAX_STRUCTURED_WIDGET_TEXT_LENGTH) &&
        (value.tone === undefined || TONES.includes(value.tone as string))
      );
    case "fields":
      return (
        hasExactKeys(value, ["kind", "fields"]) &&
        Array.isArray(value.fields) &&
        value.fields.length > 0 &&
        value.fields.length <= MAX_STRUCTURED_WIDGET_FIELDS &&
        value.fields.every(
          (field) =>
            isPlainObject(field) &&
            hasExactKeys(field, ["label", "value"]) &&
            isDisplayText(field.label, MAX_STRUCTURED_WIDGET_LABEL_LENGTH) &&
            isDisplayText(field.value, MAX_STRUCTURED_WIDGET_TEXT_LENGTH),
        )
      );
    case "progress":
      return (
        hasExactKeys(value, ["kind", "value", "max"], ["label"]) &&
        isProgressNumber(value.value) &&
        isProgressNumber(value.max) &&
        // A zero or negative maximum has no meaning to draw, and a value
        // outside the bar would have to be clamped by every renderer instead
        // of rejected once here.
        value.max > 0 &&
        value.value >= 0 &&
        value.value <= value.max &&
        (value.label === undefined ||
          isDisplayText(value.label, MAX_STRUCTURED_WIDGET_LABEL_LENGTH))
      );
    case "actions":
      return (
        hasExactKeys(value, ["kind", "actions"]) &&
        Array.isArray(value.actions) &&
        value.actions.length > 0 &&
        value.actions.length <= MAX_STRUCTURED_WIDGET_ACTIONS &&
        value.actions.every(isAction)
      );
    default:
      return false;
  }
}

/**
 * Read a published widget payload as a structured widget, or return null to
 * mean "render this as text". Null is the normal outcome for every widget that
 * has not opted in, so this is never an error path.
 */
export function parseStructuredWidget(value: unknown): StructuredWidget | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, ["pideck", "rows"])) return null;
  if (value.pideck !== STRUCTURED_WIDGET_VERSION) return null;
  if (!Array.isArray(value.rows)) return null;
  if (value.rows.length === 0 || value.rows.length > MAX_STRUCTURED_WIDGET_ROWS) return null;
  if (!value.rows.every(isRow)) return null;
  const actionIds = value.rows.flatMap((row) =>
    row.kind === "actions" ? row.actions.map((action) => action.id) : [],
  );
  // The dispatch channel carries only key + actionId, so action ids must be
  // unique across the whole widget rather than merely within one action row.
  if (new Set(actionIds).size !== actionIds.length) return null;
  return value as StructuredWidget;
}

/** Every action id the payload can dispatch, for validating one that comes back. */
export function structuredWidgetActionIds(widget: StructuredWidget): string[] {
  return widget.rows.flatMap((row) => (row.kind === "actions" ? row.actions.map((a) => a.id) : []));
}
