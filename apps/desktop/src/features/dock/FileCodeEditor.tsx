import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { MergeView } from "@codemirror/merge";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { markdownLivePreview } from "./markdown-live-preview";
import { saveOpenFile, useFileSession } from "./file-session";
import { useLocale, useT } from "../../lib/i18n/use-t";

const fileHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--file-keyword)" },
    { tag: [tags.string, tags.regexp], color: "var(--file-string)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--file-number)" },
    { tag: [tags.typeName, tags.className], color: "var(--file-type)" },
    { tag: tags.comment, color: "var(--color-muted)", fontStyle: "italic" },
    { tag: tags.function(tags.variableName), color: "var(--file-function)" },
  ]),
);
const chinesePhrases = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  "by word": "全词匹配",
  regexp: "正则表达式",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
};

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-foreground)",
    fontSize: "12px",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
  ".cm-content": { caretColor: "var(--color-foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-surface-overlay)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 30%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-foreground)" },
  ".cm-panels": {
    backgroundColor: "var(--color-surface-raised)",
    color: "var(--color-foreground)",
  },
  ".cm-textfield, .cm-button": {
    background: "var(--color-surface)",
    color: "var(--color-foreground)",
    border: "1px solid var(--color-border)",
  },
  ".cm-search": { whiteSpace: "normal" },
});

export function FileCodeEditor({
  path,
  text,
  readOnly,
  livePreview = false,
}: {
  path: string;
  text: string;
  readOnly: boolean;
  livePreview?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const parent = useRef<HTMLDivElement>(null);
  const initial = useRef({ path, text, readOnly });
  const editor = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const presentation = useRef(new Compartment());
  useEffect(() => {
    if (!parent.current) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: initial.current.text,
        extensions: [
          basicSetup,
          fileHighlight,
          editorTheme,
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                void saveOpenFile();
                return true;
              },
            },
            indentWithTab,
          ]),
          language.of(
            /\.(md|mdx|markdown)$/i.test(initial.current.path)
              ? markdown({ base: markdownLanguage, codeLanguages: languages })
              : [],
          ),
          presentation.current.of([]),
          editable.current.of(EditorState.readOnly.of(initial.current.readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) useFileSession.setState({ text: update.state.doc.toString() });
          }),
        ],
      }),
    });
    editor.current = view;
    let disposed = false;
    const description = /\.(md|mdx|markdown)$/i.test(initial.current.path)
      ? null
      : LanguageDescription.matchFilename(languages, initial.current.path);
    void description
      ?.load()
      .then((support) => {
        if (!disposed) view.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      view.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorState.phrases.of(locale === "zh" ? chinesePhrases : {}),
      ]),
    });
  }, [readOnly, locale]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: presentation.current.reconfigure(livePreview ? markdownLivePreview : []),
    });
  }, [livePreview]);
  return (
    <div
      ref={parent}
      className={`h-full min-h-0 min-w-0 ${livePreview ? "file-live-editor" : ""}`}
      aria-label={t(livePreview ? "fileLivePreview" : "fileEditor")}
    />
  );
}

export function FileConflictDiff({ disk, local }: { disk: string; local: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const extensions = [
      basicSetup,
      editorTheme,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];
    const view = new MergeView({
      parent: ref.current,
      a: { doc: disk, extensions },
      b: { doc: local, extensions },
      highlightChanges: true,
      gutter: true,
    });
    return () => view.destroy();
  }, [disk, local]);
  return <div ref={ref} className="file-merge h-full min-h-0 overflow-auto" />;
}
