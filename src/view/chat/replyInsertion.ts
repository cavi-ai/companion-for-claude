import { type MarkdownView, Notice } from "obsidian";
import { quickNotice } from "../../notice";
import { errorMessage } from "../../records";

/** A structured answer needs paragraph boundaries; plain inline text stays inline. */
export function formatReplyInsertion(text: string, before: string, after: string): string {
  const block = text.includes("\n") || /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|`{3}|~{3}|\|)/.test(text.trimStart());
  if (!block) return text;
  const boundary = (left: string, right: string): string => {
    if (!left || !right) return "";
    const breaks = /\n*$/.exec(left)![0].length + /^\n*/.exec(right)![0].length;
    return "\n".repeat(Math.max(0, 2 - breaks));
  };
  return boundary(before, text) + text + boundary(text, after);
}

type ReplyDestination = Pick<MarkdownView, "file" | "getMode" | "getState" | "setState" | "editor">;

/** Reveal the destination editor before its single undoable insertion transaction. */
export async function insertReplyIntoNote(view: ReplyDestination | null, text: string): Promise<void> {
  if (!view?.file) {
    new Notice("Open a note to insert into.");
    return;
  }
  const file = view.file;
  try {
    if (view.getMode() !== "source") await view.setState({ ...view.getState(), mode: "source" }, { history: false });
    if (view.file !== file) {
      new Notice("The destination note changed. Try inserting again.");
      return;
    }
    const editor = view.editor;
    const note = editor.getValue();
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    editor.replaceSelection(formatReplyInsertion(text, note.slice(0, from), note.slice(to)));
    editor.focus();
    quickNotice("Inserted into note");
  } catch (error) {
    new Notice(`Couldn't insert the reply: ${errorMessage(error)}`);
  }
}
