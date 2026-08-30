import { describe, expect, it } from "vitest";
import {
  MAX_STRUCTURED_WIDGET_ACTIONS,
  MAX_STRUCTURED_WIDGET_LABEL_LENGTH,
  MAX_STRUCTURED_WIDGET_ROWS,
  MAX_STRUCTURED_WIDGET_TEXT_LENGTH,
} from "./limits.js";
import {
  parseStructuredWidget,
  structuredWidgetActionIds,
  type StructuredWidgetRow,
} from "./extension-widget-payload.js";

function widget(rows: unknown[]) {
  return { pideck: 1, rows };
}

describe("parseStructuredWidget", () => {
  it("accepts every row kind in one payload", () => {
    const rows: StructuredWidgetRow[] = [
      { kind: "text", text: "3 agents running", tone: "muted" },
      {
        kind: "fields",
        fields: [
          { label: "Queued", value: "2" },
          { label: "Failed", value: "0" },
        ],
      },
      { kind: "progress", value: 3, max: 8, label: "Fleet" },
      {
        kind: "actions",
        actions: [
          { id: "retry", label: "Retry" },
          { id: "stop", label: "Stop all", style: "danger", confirm: "Stop every agent?" },
        ],
      },
    ];
    expect(parseStructuredWidget(widget(rows))).toEqual({ pideck: 1, rows });
  });

  it("reads a payload that carries no actions at all", () => {
    const parsed = parseStructuredWidget(widget([{ kind: "text", text: "idle" }]));
    expect(parsed).not.toBeNull();
    expect(structuredWidgetActionIds(parsed!)).toEqual([]);
  });

  it("collects action ids across separate action rows", () => {
    const parsed = parseStructuredWidget(
      widget([
        { kind: "actions", actions: [{ id: "a", label: "A" }] },
        { kind: "text", text: "between" },
        { kind: "actions", actions: [{ id: "b", label: "B" }] },
      ]),
    );
    expect(structuredWidgetActionIds(parsed!)).toEqual(["a", "b"]);
  });
});

describe("payloads that fall back to text rather than erroring", () => {
  // Every case here is a widget that still has to show its content. None of
  // them is a protocol violation; they simply are not structured widgets.
  const fallbacks: Array<[string, unknown]> = [
    ["a plain string, the overwhelmingly common widget", "3 agents running"],
    ["an array of lines", ["a", "b"]],
    ["an arbitrary object", { agents: 3, queued: 2 }],
    ["null", null],
    ["a newer schema version", { pideck: 2, rows: [{ kind: "text", text: "hi" }] }],
    ["a version that is a string", { pideck: "1", rows: [{ kind: "text", text: "hi" }] }],
    ["no rows key", { pideck: 1 }],
    ["rows that are not an array", { pideck: 1, rows: { kind: "text", text: "hi" } }],
    ["an empty row list, which would draw an empty card", { pideck: 1, rows: [] }],
    ["an unknown row kind", { pideck: 1, rows: [{ kind: "chart", data: [1, 2] }] }],
    ["an extra top-level key", { pideck: 1, rows: [{ kind: "text", text: "hi" }], style: "red" }],
  ];

  for (const [name, value] of fallbacks) {
    it(`falls back for ${name}`, () => {
      expect(parseStructuredWidget(value)).toBeNull();
    });
  }
});

describe("bounds and hostile payloads", () => {
  it("rejects more rows than the cap", () => {
    const row = { kind: "text", text: "x" };
    expect(
      parseStructuredWidget(widget(Array(MAX_STRUCTURED_WIDGET_ROWS).fill(row))),
    ).not.toBeNull();
    expect(
      parseStructuredWidget(widget(Array(MAX_STRUCTURED_WIDGET_ROWS + 1).fill(row))),
    ).toBeNull();
  });

  it("rejects more actions in one row than the cap", () => {
    const actions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `a${index}`, label: "Go" }));
    expect(
      parseStructuredWidget(
        widget([{ kind: "actions", actions: actions(MAX_STRUCTURED_WIDGET_ACTIONS) }]),
      ),
    ).not.toBeNull();
    expect(
      parseStructuredWidget(
        widget([{ kind: "actions", actions: actions(MAX_STRUCTURED_WIDGET_ACTIONS + 1) }]),
      ),
    ).toBeNull();
  });

  it("rejects two actions answering to one id, which would make a dispatch ambiguous", () => {
    expect(
      parseStructuredWidget(
        widget([
          {
            kind: "actions",
            actions: [
              { id: "same", label: "First" },
              { id: "same", label: "Second" },
            ],
          },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects duplicate action ids across separate action rows", () => {
    expect(
      parseStructuredWidget(
        widget([
          { kind: "actions", actions: [{ id: "same", label: "First" }] },
          { kind: "text", text: "between" },
          { kind: "actions", actions: [{ id: "same", label: "Second" }] },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects text past the cap and an over-long label", () => {
    const long = "x".repeat(MAX_STRUCTURED_WIDGET_TEXT_LENGTH + 1);
    expect(parseStructuredWidget(widget([{ kind: "text", text: long }]))).toBeNull();
    expect(
      parseStructuredWidget(
        widget([
          {
            kind: "actions",
            actions: [{ id: "a", label: "x".repeat(MAX_STRUCTURED_WIDGET_LABEL_LENGTH + 1) }],
          },
        ]),
      ),
    ).toBeNull();
  });

  it("keeps newlines in text but rejects other control characters", () => {
    expect(parseStructuredWidget(widget([{ kind: "text", text: "one\ntwo" }]))).not.toBeNull();
    expect(parseStructuredWidget(widget([{ kind: "text", text: "one\u0007two" }]))).toBeNull();
    // A terminal escape must never reach a renderer through a widget payload.
    expect(parseStructuredWidget(widget([{ kind: "text", text: "\u001b[31mred" }]))).toBeNull();
  });

  it("rejects an action id carrying control or formatting characters", () => {
    for (const id of ["a\u0000b", "a\u200eb", "a\nb"]) {
      expect(
        parseStructuredWidget(widget([{ kind: "actions", actions: [{ id, label: "Go" }] }])),
      ).toBeNull();
    }
  });

  it("rejects empty strings, which would render an unlabelled control", () => {
    expect(parseStructuredWidget(widget([{ kind: "text", text: "" }]))).toBeNull();
    expect(
      parseStructuredWidget(widget([{ kind: "actions", actions: [{ id: "", label: "Go" }] }])),
    ).toBeNull();
    expect(
      parseStructuredWidget(widget([{ kind: "actions", actions: [{ id: "a", label: "" }] }])),
    ).toBeNull();
  });

  it("rejects a progress row no renderer could draw", () => {
    const progress = (value: unknown, max: unknown) =>
      parseStructuredWidget(widget([{ kind: "progress", value, max }]));
    expect(progress(0, 1)).not.toBeNull();
    expect(progress(1, 1)).not.toBeNull();
    expect(progress(2, 1)).toBeNull();
    expect(progress(-1, 1)).toBeNull();
    expect(progress(0, 0)).toBeNull();
    expect(progress(0, -1)).toBeNull();
    expect(progress(Number.NaN, 1)).toBeNull();
    expect(progress(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(progress("0", 1)).toBeNull();
  });

  it("rejects an empty fields or actions list", () => {
    expect(parseStructuredWidget(widget([{ kind: "fields", fields: [] }]))).toBeNull();
    expect(parseStructuredWidget(widget([{ kind: "actions", actions: [] }]))).toBeNull();
  });

  it("rejects unknown keys and unknown enum values on a row", () => {
    expect(
      parseStructuredWidget(widget([{ kind: "text", text: "hi", onClick: "alert(1)" }])),
    ).toBeNull();
    expect(
      parseStructuredWidget(widget([{ kind: "text", text: "hi", tone: "rainbow" }])),
    ).toBeNull();
    expect(
      parseStructuredWidget(
        widget([{ kind: "actions", actions: [{ id: "a", label: "Go", style: "huge" }] }]),
      ),
    ).toBeNull();
  });
});
