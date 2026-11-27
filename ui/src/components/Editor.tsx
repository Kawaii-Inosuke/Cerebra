// Markdown editor: CodeMirror 6 with `[[` autocomplete from the library's note titles.
import { autocompletion, closeBrackets, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.25em", color: "var(--fg)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.12em", color: "var(--fg)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--fg)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent-text)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
  { tag: t.monospace, color: "var(--accent-text)", fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--muted-strong)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--fg)" },
  ".cm-content": { padding: "0 0 40vh" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
});

export function wikiCompletion(getTitles: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]\[|#\n]*/);
    if (!m) return null;
    const from = m.from + 2;
    return {
      from,
      options: getTitles().map((title) => ({
        label: title,
        type: "text",
        apply: (view: EditorView, _c: unknown, f: number, to: number) => {
          // Reuse a `]]` that's already there (auto-closed brackets) and put the cursor after it.
          const hasClose = view.state.sliceDoc(to, to + 2) === "]]";
          const insert = hasClose ? title : `${title}]]`;
          view.dispatch({
            changes: { from: f, to, insert },
            selection: { anchor: f + title.length + 2 },
          });
        },
      })),
      validFor: /^[^\]\[|#\n]*$/,
    };
  };
}

export function Editor({
  value,
  onChange,
  onSave,
  titles,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  titles: string[];
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onSave, titles });
  cbs.current = { onChange, onSave, titles };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          closeBrackets(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          placeholder("Start writing… Type [[ to link another note."),
          autocompletion({ override: [wikiCompletion(() => cbs.current.titles)], icons: false }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                cbs.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": "Note text", spellcheck: "true" }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns its text after mount; `value` only seeds it.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Replace the text if the note was swapped underneath (e.g. saved and reformatted).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value && !v.hasFocus) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="h-full min-h-[50vh]" data-testid="editor" />;
}
