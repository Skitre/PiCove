/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { attachMacArrowKeyInsertGuard, isMacArrowKeyControlInsert } from "./mac-arrow-key-insert";

const ARROW_CONTROLS = {
  left: "\u001c",
  right: "\u001d",
  up: "\u001e",
  down: "\u001f",
} as const;

function insertText(data: string, inputType = "insertText") {
  return { inputType, data };
}

describe("isMacArrowKeyControlInsert", () => {
  it("matches the four Mac arrow-key control codes on macOS insertText", () => {
    for (const data of Object.values(ARROW_CONTROLS)) {
      expect(isMacArrowKeyControlInsert(insertText(data), true)).toBe(true);
    }
  });

  it("ignores the same payloads off macOS", () => {
    for (const data of Object.values(ARROW_CONTROLS)) {
      expect(isMacArrowKeyControlInsert(insertText(data), false)).toBe(false);
    }
  });

  it("preserves ordinary text, CJK, emoji, and newlines", () => {
    for (const data of ["a", "中", "🙂", "\n", "\r", "hello\nworld", " "]) {
      expect(isMacArrowKeyControlInsert(insertText(data), true)).toBe(false);
    }
  });

  it("does not treat paste, IME, undo, or mixed payloads as arrow inserts", () => {
    expect(
      isMacArrowKeyControlInsert(insertText(ARROW_CONTROLS.right, "insertFromPaste"), true),
    ).toBe(false);
    expect(
      isMacArrowKeyControlInsert(insertText(ARROW_CONTROLS.right, "insertCompositionText"), true),
    ).toBe(false);
    expect(isMacArrowKeyControlInsert({ inputType: "historyUndo", data: null }, true)).toBe(false);
    expect(isMacArrowKeyControlInsert(insertText(`${ARROW_CONTROLS.right}a`), true)).toBe(false);
    expect(isMacArrowKeyControlInsert(insertText(""), true)).toBe(false);
    expect(isMacArrowKeyControlInsert(insertText(ARROW_CONTROLS.right), false)).toBe(false);
  });
});

describe("attachMacArrowKeyInsertGuard", () => {
  let textarea: HTMLTextAreaElement;

  afterEach(() => {
    textarea.remove();
  });

  function mount(value = "hello"): HTMLTextAreaElement {
    textarea = document.createElement("textarea");
    textarea.value = value;
    document.body.append(textarea);
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    return textarea;
  }

  function dispatchInsert(data: string, inputType = "insertText"): InputEvent {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data,
      inputType,
    });
    textarea.dispatchEvent(event);
    return event;
  }

  it("cancels arrow-control insertText on macOS without moving the caret or changing value", () => {
    mount();
    const detach = attachMacArrowKeyInsertGuard(textarea, true);
    const event = dispatchInsert(ARROW_CONTROLS.right);
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("hello");
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
    detach();
  });

  it("does not intercept ordinary insertText, paste, or non-macOS control inserts", () => {
    mount();
    const detach = attachMacArrowKeyInsertGuard(textarea, true);
    expect(dispatchInsert("a").defaultPrevented).toBe(false);
    expect(dispatchInsert("中文").defaultPrevented).toBe(false);
    expect(dispatchInsert("🙂").defaultPrevented).toBe(false);
    expect(dispatchInsert("\n").defaultPrevented).toBe(false);
    expect(dispatchInsert("pasted\ntext", "insertFromPaste").defaultPrevented).toBe(false);
    detach();

    const offMac = attachMacArrowKeyInsertGuard(textarea, false);
    expect(dispatchInsert(ARROW_CONTROLS.left).defaultPrevented).toBe(false);
    offMac();
  });

  it("stops intercepting after cleanup", () => {
    mount();
    const detach = attachMacArrowKeyInsertGuard(textarea, true);
    detach();
    expect(dispatchInsert(ARROW_CONTROLS.up).defaultPrevented).toBe(false);
  });
});
