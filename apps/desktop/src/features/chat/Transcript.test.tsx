import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantOrderedContent,
  DurationLabel,
  ExecutionTrace,
  ExtensionMessageRow,
} from "./Transcript";
import type { TranscriptBlock, TranscriptRow } from "./transcript-model";

function toolBlock(id: string, status: "running" | "done"): TranscriptBlock {
  return {
    kind: "tool",
    tool: { id, name: "read", status },
  };
}

describe("DurationLabel", () => {
  it("keeps counting through an intermediate end time while the turn is active", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(11_700);

    try {
      const activeMarkup = renderToStaticMarkup(
        <DurationLabel startedAt={1_000} endedAt={7_100} active />,
      );
      const settledMarkup = renderToStaticMarkup(
        <DurationLabel startedAt={1_000} endedAt={7_100} />,
      );

      expect(activeMarkup).toContain("10.7s");
      expect(settledMarkup).toContain("6.1s");
    } finally {
      now.mockRestore();
    }
  });
});

describe("ExecutionTrace", () => {
  it("shows a spinner for an active turn and keeps its content collapsed", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done")]}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("Running 1 action");
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain("execution-trace-spinner");
    expect(markup).not.toContain("lucide-list-tree");
    expect(markup).not.toContain("lucide-brain");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("settles after the agent turn ends", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done")]}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    expect(markup).toContain("1 action completed");
    expect(markup).toContain("lucide-list-tree");
    expect(markup).not.toContain("lucide-loader-circle");
    expect(markup).not.toContain("execution-trace-spinner");
  });

  it("keeps a mixed completed-and-running trace active", () => {
    const markup = renderToStaticMarkup(
      <ExecutionTrace
        blocks={[toolBlock("tool-1", "done"), toolBlock("tool-2", "running")]}
        stepCount={2}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("Running 2 actions");
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).not.toContain("2 actions completed");
  });
});

describe("AssistantOrderedContent", () => {
  it.each([" \n\t ", "\n<dcp-id>m013</dcp-id>\n"])(
    "keeps all six actions together across text with no visible content: %j",
    (separator) => {
      const tools = Array.from({ length: 6 }, (_, index) => toolBlock(`tool-${index}`, "done"));
      const markup = renderToStaticMarkup(
        <AssistantOrderedContent
          blocks={[...tools.slice(0, 5), { kind: "text", text: separator }, tools[5]!]}
          mode="static"
          showCaret={false}
          turnActive={false}
        />,
      );

      expect(markup).toContain("6 actions completed");
      expect(markup).not.toContain("5 actions completed");
      expect(markup).not.toContain("1 action completed");
      expect(markup).not.toContain("dcp-id");
    },
  );

  it("keeps only the trailing trace active", () => {
    const markup = renderToStaticMarkup(
      <AssistantOrderedContent
        blocks={[
          toolBlock("tool-1", "done"),
          { kind: "unknown", type: "separator", value: null },
          toolBlock("tool-2", "done"),
        ]}
        mode="static"
        showCaret={false}
        turnActive
      />,
    );

    expect(markup).toContain("1 action completed");
    expect(markup).toContain("Running 1 action");
  });
});

describe("ExtensionMessageRow", () => {
  it("uses the Agent coordination title as the only closed disclosure control", () => {
    const row: TranscriptRow = {
      key: "custom:1",
      role: "custom",
      blocks: [{ kind: "text", text: "Reply with: internal_tool({ action: 'respond' })" }],
      copyText: "Reply with: internal_tool({ action: 'respond' })",
      customType: "subagent_supervisor_request",
      details: { id: "request-1" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-1",
        title: "This must stay hidden",
        summary: "This must also stay hidden",
      },
    };

    const markup = renderToStaticMarkup(<ExtensionMessageRow row={row} />);

    expect(markup).toContain("Agent coordination");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Technical details");
    expect(markup).not.toContain("Reply with: internal_tool");
    expect(markup).not.toContain("This must stay hidden");
    expect(markup).not.toContain("This must also stay hidden");
    expect(markup).not.toContain("Extension message");
    expect(markup).not.toContain("border-accent");
    expect(markup).not.toContain("<details");
  });

  it("renders a user decision from bounded presentation copy without exposing its custom type", () => {
    const row: TranscriptRow = {
      key: "custom:2",
      role: "custom",
      blocks: [],
      copyText: "internal payload",
      customType: "private_decision_protocol",
      extensionPresentation: {
        version: 1,
        extensionId: "review-extension",
        sourceLabel: "Review",
        audience: "user",
        kind: "decision",
        correlationId: "review-1",
        status: "pending",
        title: "Choose a review path",
        summary: "The extension is waiting for your choice.",
      },
    };

    const markup = renderToStaticMarkup(<ExtensionMessageRow row={row} />);

    expect(markup).toContain("Choose a review path");
    expect(markup).toContain("Pending");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("The extension is waiting for your choice.");
    expect(markup).not.toContain("private_decision_protocol");
    expect(markup).not.toContain("Technical details");
    expect(markup).not.toContain("border-y");
  });

  it("keeps unknown visible messages in a neutral closed fallback", () => {
    const row: TranscriptRow = {
      key: "custom:3",
      role: "custom",
      blocks: [{ kind: "text", text: "Legacy extension content" }],
      copyText: "Legacy extension content",
      customType: "legacy-extension",
    };

    const markup = renderToStaticMarkup(<ExtensionMessageRow row={row} />);

    expect(markup).toContain("Extension message");
    expect(markup).not.toContain("Legacy extension content");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("border-y");
    expect(markup).not.toContain("border-accent");
  });
});
