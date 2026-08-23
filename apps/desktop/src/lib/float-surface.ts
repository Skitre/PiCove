/**
 * Which surface this document is. PiDeck normally boots the full application
 * shell; a detached Extension Float boots a single presentation slot instead
 * (extension-deck.md, "Detached float windows").
 *
 * Pure so the branch can be tested without a window. The bounds mirror
 * `validate_slot_id` in `src-tauri/src/extension_float.rs` — a slot id that one
 * layer accepts and the other rejects would strand a window with no content.
 */

const MAX_SLOT_ID_LENGTH = 512;

/**
 * Unicode Cc: C0 controls, DEL, and C1 controls. Never legitimate in a slot id,
 * and a query-string smuggling risk. Checked by codepoint rather than by regex
 * so the source stays free of literal control bytes; the range matches Rust's
 * `char::is_control`, which guards the same value on the other side.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export type SurfaceRoute = { kind: "app" } | { kind: "float"; slotId: string };

function isUsableSlotId(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= MAX_SLOT_ID_LENGTH &&
    !hasControlCharacter(value)
  );
}

/**
 * A `surface=float` document with an unusable slot falls back to the
 * application shell rather than rendering an empty window: a Float window with
 * no slot has nothing to show and no way to recover.
 */
export function surfaceRouteFromSearch(search: string): SurfaceRoute {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { kind: "app" };
  }
  if (params.get("surface") !== "float") return { kind: "app" };
  const slotId = params.get("slot");
  return isUsableSlotId(slotId) ? { kind: "float", slotId } : { kind: "app" };
}

export function currentSurfaceRoute(): SurfaceRoute {
  if (typeof window === "undefined") return { kind: "app" };
  return surfaceRouteFromSearch(window.location.search);
}
