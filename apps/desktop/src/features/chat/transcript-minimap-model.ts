import { micromark } from "micromark";
import { parseUserAttachments, type TranscriptRow } from "./transcript-model";
import type { Translate } from "../../lib/i18n/use-t";

export type TranscriptTurn = {
  key: string;
  rowIndex: number;
  user: TranscriptRow;
  reply?: TranscriptRow;
  error?: TranscriptRow;
};

export function buildTranscriptTurns(rows: readonly TranscriptRow[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.role === "user") turns.push({ key: row.key, rowIndex, user: row });
    else {
      const turn = turns.at(-1);
      if (!turn) continue;
      if (row.role === "assistant") turn.reply = row;
      if (row.role === "error") turn.error = row;
    }
  }
  return turns;
}

export function minimapLineWidth(distance: number | null): number {
  return distance === null ? 6 : ([26, 20, 14, 10][Math.abs(distance)] ?? 6);
}

function plainPreview(markdown: string): string {
  const template = document.createElement("template");
  template.innerHTML = micromark(markdown.slice(0, 8000));
  for (const image of template.content.querySelectorAll("img")) image.replaceWith(image.alt);
  for (const block of template.content.querySelectorAll(
    "p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,br",
  )) {
    block.append(document.createTextNode("\n"));
  }
  return (template.content.textContent ?? "").trim().slice(0, 1200);
}

export function transcriptTurnPreview(turn: TranscriptTurn, working: boolean, t: Translate) {
  const parsed = parseUserAttachments(turn.user.copyText);
  const files = [
    ...parsed.files.map((file) => file.name),
    ...parsed.documents.map((file) => file.name),
  ];
  const title = plainPreview(parsed.text) || files.join(", ") || t("minimapImagePrompt");
  const reply = turn.reply;
  const final = reply?.sections?.final
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
  const text =
    final ||
    reply?.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("\n\n") ||
    "";
  const failed =
    !!turn.error || reply?.outcome?.status === "error" || reply?.outcome?.status === "aborted";
  return {
    title,
    text:
      plainPreview(text) ||
      t(failed ? "minimapReplyFailed" : working ? "minimapReplyWorking" : "minimapNoReply"),
    status: failed ? t("minimapReplyFailed") : working ? t("minimapReplyWorking") : null,
  };
}
