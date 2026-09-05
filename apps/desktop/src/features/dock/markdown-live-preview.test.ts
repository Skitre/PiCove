import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { markdownLivePreview } from "./markdown-live-preview";

const source =
  "# Heading\n\nA **bold** and *italic* paragraph with `code`.\n\n- [ ] First task\n- [x] Done\n\n> Quote\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```mermaid\ngraph LR\nA-->B\n```\n";
const decorationClasses = (state: EditorState) =>
  state.facet(EditorView.decorations).flatMap((set) => {
    if (typeof set === "function") return [];
    const classes: string[] = [];
    set.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.class) classes.push(decoration.spec.class);
    });
    return classes;
  });

describe("Markdown live preview", () => {
  it("presents headings and inline formats without changing the Markdown document", () => {
    const state = EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage }), markdownLivePreview],
    });
    expect(state.doc.toString()).toBe(source);
    expect(decorationClasses(state)).toEqual(
      expect.arrayContaining([
        "file-live-h1",
        "file-live-strong",
        "file-live-emphasis",
        "file-live-code",
        "file-live-quote",
      ]),
    );
  });
  it("keeps exact source and selection when toggling live presentation", () => {
    const mode = new Compartment();
    let state = EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage }), mode.of(markdownLivePreview)],
    });
    state = state.update({ selection: { anchor: 20 } }).state;
    state = state.update({ effects: mode.reconfigure([]) }).state;
    state = state.update({ effects: mode.reconfigure(markdownLivePreview) }).state;
    expect(state.doc.toString()).toBe(source);
    expect(state.selection.main.head).toBe(20);
  });
  it("updates formatting after typing and leaves fenced code as code", () => {
    let state = EditorState.create({
      doc: "plain\n\n```ts\n# not a heading\n```",
      extensions: [markdown({ base: markdownLanguage }), markdownLivePreview],
    });
    expect(decorationClasses(state)).not.toContain("file-live-h1");
    state = state.update({ changes: { from: 0, insert: "## " } }).state;
    expect(decorationClasses(state)).toContain("file-live-h2");
    expect(state.doc.toString()).toBe("## plain\n\n```ts\n# not a heading\n```");
  });
});
