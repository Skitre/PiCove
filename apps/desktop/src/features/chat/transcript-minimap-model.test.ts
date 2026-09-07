/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  buildTranscriptTurns,
  minimapLineWidth,
  transcriptTurnPreview,
} from "./transcript-minimap-model";
import { buildAttachedFileBlock, type TranscriptRow } from "./transcript-model";
import { en } from "../../lib/i18n/en";
import type { Translate } from "../../lib/i18n/use-t";

const t: Translate = (key) => en[key];
function row(key: string, role: TranscriptRow["role"], text = ""): TranscriptRow {
  return { key, role, copyText: text, blocks: [{ kind: "text", text }] };
}

describe("transcript minimap model", () => {
  it("groups each user prompt with its last assistant reply and ignores standalone events", () => {
    const rows = [
      row("event", "event"),
      row("u1", "user", "First"),
      row("a1", "assistant", "Progress"),
      row("tool", "custom"),
      row("a2", "assistant", "Final"),
      row("u2", "user", "Second"),
      row("u3", "user", "Third"),
    ];
    const turns = buildTranscriptTurns(rows);
    expect(turns.map((turn) => [turn.key, turn.rowIndex, turn.reply?.key])).toEqual([
      ["u1", 1, "a2"],
      ["u2", 5, undefined],
      ["u3", 6, undefined],
    ]);
  });

  it("extracts final prose without thinking, tools, HTML or Markdown rendering", () => {
    const user = row("u", "user", "**Review** this");
    const reply = row("a", "assistant", "Earlier progress");
    reply.sections = {
      ordered: [],
      initialThinking: [],
      intro: [],
      activity: [],
      stepCount: 1,
      final: [{ kind: "text", text: "**Done** [details](https://example.com)\n\nNext paragraph" }],
    };
    reply.blocks.push({ kind: "thinking", text: "Private thought" });
    const preview = transcriptTurnPreview({ key: "u", rowIndex: 0, user, reply }, false, t);
    expect(preview.title).toBe("Review this");
    expect(preview.text).toMatch(/Done details\s+Next paragraph/);
    expect(preview.text).not.toMatch(/Earlier|Private|https|<p>|\*\*/);
    expect(preview.status).toBeNull();
  });

  it("uses attachment names without exposing their contents and handles missing or failed replies", () => {
    const user = row("u", "user", buildAttachedFileBlock("notes.txt", "attachment secret"));
    const turn = { key: "u", rowIndex: 0, user };
    expect(transcriptTurnPreview(turn, false, t)).toMatchObject({
      title: "notes.txt",
      text: en.minimapNoReply,
    });
    expect(transcriptTurnPreview(turn, true, t).text).toBe(en.minimapReplyWorking);
    expect(transcriptTurnPreview({ ...turn, error: row("error", "error") }, false, t).text).toBe(
      en.minimapReplyFailed,
    );
    expect(transcriptTurnPreview({ ...turn, user: row("image", "user") }, false, t).title).toBe(
      en.minimapImagePrompt,
    );
  });

  it("keeps idle ticks equal and expands only three neighbors on either side", () => {
    expect(minimapLineWidth(null)).toBe(6);
    expect([-4, -3, -2, -1, 0, 1, 2, 3, 4].map(minimapLineWidth)).toEqual([
      6, 10, 14, 20, 26, 20, 14, 10, 6,
    ]);
  });
});
