import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { tCurrent } from "../../lib/i18n/use-t";

const focusChanged = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) =>
    (transaction.effects.find((effect) => effect.is(focusChanged))?.value as boolean) ?? value,
});
const roots = new WeakMap<HTMLElement, Root>();

class RenderedMarkdownBlock extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: RenderedMarkdownBlock) {
    return this.source === other.source && this.from === other.from && this.to === other.to;
  }
  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "file-live-block";
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", tCurrent("fileEditMarkdownBlock"));
    const enter = () => {
      view.dispatch({
        selection: { anchor: this.from },
        effects: focusChanged.of(true),
        scrollIntoView: true,
      });
      view.focus();
    };
    element.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      enter();
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        enter();
      }
    });
    const root = createRoot(element);
    roots.set(element, root);
    void import("../chat/MarkdownMessage").then(({ MarkdownMessage }) => {
      if (roots.get(element) === root) {
        root.render(createElement(MarkdownMessage, { content: this.source }));
        requestAnimationFrame(() => view.requestMeasure());
      }
    });
    return element;
  }
  destroy(element: HTMLElement) {
    const root = roots.get(element);
    roots.delete(element);
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

class TaskCheckbox extends WidgetType {
  constructor(
    readonly from: number,
    readonly checked: boolean,
    readonly readOnly: boolean,
  ) {
    super();
  }
  eq(other: TaskCheckbox) {
    return (
      this.from === other.from && this.checked === other.checked && this.readOnly === other.readOnly
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "file-live-checkbox";
    input.checked = this.checked;
    input.disabled = this.readOnly;
    input.setAttribute("aria-label", tCurrent("fileToggleTask"));
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("change", () => {
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? "x" : " " },
      });
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "file-live-bullet";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

function decorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const active = state.field(focused)
    ? state.selection.ranges.map((range) => ({
        from: state.doc.lineAt(range.from).from,
        to: state.doc.lineAt(range.to).to,
      }))
    : [];
  const editing = (from: number, to: number) =>
    active.some((range) => range.from <= to && range.to >= from);
  const hidden = (from: number, to: number) => {
    if (from < to && !editing(from, to)) ranges.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lineClasses = new Map<number, Set<string>>();
  const lineClass = (position: number, className: string) => {
    const line = state.doc.lineAt(position).from;
    const classes = lineClasses.get(line) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(line, classes);
  };
  syntaxTree(state).iterate({
    enter(node) {
      const { name, from, to } = node;
      if (
        name === "Table" ||
        name === "HorizontalRule" ||
        (name === "FencedCode" &&
          state
            .sliceDoc(from, Math.min(to, from + 80))
            .split("\n")[0]
            .includes("mermaid"))
      ) {
        if (!editing(from, to)) {
          ranges.push(
            Decoration.replace({
              block: true,
              widget: new RenderedMarkdownBlock(state.sliceDoc(from, to), from, to),
            }).range(from, to),
          );
          return false;
        }
      }
      const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name);
      if (heading) lineClass(from, `file-live-h${heading[1]}`);
      if (name === "HeaderMark") hidden(from, to);
      if (name === "StrongEmphasis") mark(from, to, "file-live-strong");
      if (name === "Emphasis") mark(from, to, "file-live-emphasis");
      if (name === "Strikethrough") mark(from, to, "file-live-strike");
      if (name === "InlineCode") mark(from, to, "file-live-code");
      if (["EmphasisMark", "CodeMark", "StrikethroughMark"].includes(name)) hidden(from, to);
      if (name === "Link") mark(from, to, "file-live-link");
      if (
        (name === "LinkMark" || name === "URL" || name === "LinkTitle") &&
        node.node.parent?.name === "Link" &&
        state.sliceDoc(node.node.parent.from, node.node.parent.from + 1) === "["
      )
        hidden(from, to);
      if (name === "QuoteMark") {
        lineClass(from, "file-live-quote");
        hidden(from, to);
      }
      if (name === "ListMark") {
        lineClass(from, "file-live-list");
        if (!editing(from, to) && /^[-*+]$/.test(state.sliceDoc(from, to))) {
          const task = /^\s*[-*+] \[[ xX]\]/.test(state.doc.lineAt(from).text);
          ranges.push(
            Decoration.replace({ widget: task ? undefined : new Bullet() }).range(from, to),
          );
        }
      }
      if (name === "TaskMarker" && !editing(from, to)) {
        ranges.push(
          Decoration.replace({
            widget: new TaskCheckbox(
              from,
              /x/i.test(state.sliceDoc(from, to)),
              state.facet(EditorState.readOnly),
            ),
          }).range(from, to),
        );
      }
      if (name === "FencedCode" || name === "CodeBlock") {
        for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++)
          lineClass(state.doc.line(line).from, "file-live-fenced-code");
      }
    },
  });
  for (const [from, classes] of lineClasses)
    ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(from));
  return Decoration.set(ranges, true);
}

const liveDecorations = StateField.define<DecorationSet>({
  create: decorations,
  update(value, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.reconfigured ||
      transaction.effects.some((effect) => effect.is(focusChanged)) ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    )
      return decorations(transaction.state);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const markdownLivePreview = [
  focused,
  liveDecorations,
  EditorView.focusChangeEffect.of((_state, focus) => focusChanged.of(focus)),
  EditorView.lineWrapping,
];
