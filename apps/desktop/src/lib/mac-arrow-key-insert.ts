/**
 * On macOS, Tauri's `unstable` child-webview path lets AppKit treat arrow keys as
 * `insertText` of the classic Mac control codes (Left FS, Right GS, Up RS, Down US).
 * They render as tofu boxes and persist into the draft. See tauri#10194.
 *
 * Cancel only that `insertText` payload. Do not touch keydown (caret/selection),
 * IME, paste, undo, or other C0 characters that a prompt may legitimately contain.
 */

const ARROW_KEY_CONTROL_MIN = 0x1c;
const ARROW_KEY_CONTROL_MAX = 0x1f;

export type BeforeInputLike = {
  inputType?: string;
  data?: string | null;
};

export function isMacArrowKeyControlInsert(event: BeforeInputLike, isMac: boolean): boolean {
  if (!isMac || event.inputType !== "insertText" || event.data == null) return false;
  if (event.data.length !== 1) return false;
  const code = event.data.charCodeAt(0);
  return code >= ARROW_KEY_CONTROL_MIN && code <= ARROW_KEY_CONTROL_MAX;
}

function cancelMacArrowKeyControlInsert(event: Event, isMac: boolean): boolean {
  if (!isMacArrowKeyControlInsert(event as BeforeInputLike, isMac)) return false;
  event.preventDefault();
  return true;
}

export function attachMacArrowKeyInsertGuard(element: EventTarget, isMac: boolean): () => void {
  const onBeforeInput = (event: Event) => {
    cancelMacArrowKeyControlInsert(event, isMac);
  };
  element.addEventListener("beforeinput", onBeforeInput, true);
  return () => element.removeEventListener("beforeinput", onBeforeInput, true);
}
