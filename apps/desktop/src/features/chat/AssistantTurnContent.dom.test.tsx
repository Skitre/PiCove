/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { AssistantTurnContent } from "./Transcript";
import { buildTranscriptRows, type TranscriptBlock, type TranscriptRow } from "./transcript-model";

vi.mock("./MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));

function completedTurn(toolCount = 2, stopReason = "stop"): TranscriptRow {
  const messages: SerializableAgentMessage[] = [{ role: "user", content: "Inspect the project" }];
  for (let index = 0; index < toolCount; index++) {
    messages.push(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: `Plan step ${index + 1}` },
          { type: "text", text: `Progress update ${index + 1}` },
          {
            type: "toolCall",
            id: `tool-${index}`,
            name: "bash",
            arguments: { command: `printf 'step ${index + 1}'` },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: `tool-${index}`,
        toolName: "bash",
        content: [{ type: "text", text: `Output ${index + 1}` }],
        isError: false,
      },
    );
  }
  messages.push({
    role: "assistant",
    stopReason,
    content: [
      { type: "thinking", thinking: "Combine the findings" },
      { type: "text", text: "Final response" },
    ],
  });
  return buildTranscriptRows(messages)[1]!;
}

function turn(row: TranscriptRow, active = false, mode: "streaming" | "static" = "static") {
  return <AssistantTurnContent row={row} turnActive={active} mode={mode} showCaret={false} />;
}

describe("completed assistant process", () => {
  beforeEach(() => {
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ desktopSettings: null });
  });

  it("waits for the whole turn to settle, then folds all progress and keeps the final answer visible", async () => {
    const user = userEvent.setup();
    const row = completedTurn();
    const { rerender } = render(turn(row, true));

    expect(await screen.findByText("Progress update 1")).toBeVisible();
    expect(screen.getByText("Progress update 2")).toBeVisible();
    expect(screen.getByText("Final response")).toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    const firstTrace = screen.getAllByRole("button", { name: "1 action completed" })[0]!;
    await user.click(firstTrace);
    await user.click(screen.getByRole("button", { name: /printf 'step 1'/ }));
    expect(screen.getByText("Output 1")).toBeVisible();

    // The model can finish its text before agent_settled (retry/continuation).
    rerender(turn({ ...row }, true));
    expect(screen.getByText("Output 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Execution process/ })).not.toBeInTheDocument();

    rerender(turn(row));
    const process = screen.getByRole("button", { name: "Execution process · 2 actions" });
    expect(process).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Progress update 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Progress update 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Output 1")).not.toBeInTheDocument();
    expect(screen.getByText("Final response")).toBeVisible();
    const divider = screen.getByRole("separator");
    expect(
      process.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      divider.compareDocumentPosition(screen.getByText("Final response")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reopens the process with its original groups and preserves independent disclosures across updates", async () => {
    const user = userEvent.setup();
    const row = completedTurn();
    const { rerender } = render(turn(row));
    const process = screen.getByRole("button", { name: "Execution process · 2 actions" });
    await user.click(process);
    expect(await screen.findByText("Progress update 1")).toBeVisible();
    const firstUpdate = screen.getByText("Progress update 1");
    const secondUpdate = screen.getByText("Progress update 2");
    expect(
      firstUpdate.compareDocumentPosition(secondUpdate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const groups = screen.getAllByRole("button", { name: "1 action completed" });
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("aria-expanded", "false");
    expect(groups[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /printf 'step 1'/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /printf 'step 2'/ })).not.toBeInTheDocument();
    await user.click(groups[0]!);
    expect(screen.getByRole("button", { name: /printf 'step 1'/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(groups[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /printf 'step 2'/ })).not.toBeInTheDocument();
    await user.click(groups[1]!);
    for (const thought of screen.getAllByRole("button", { name: /^(Thinking|Thought process)$/ })) {
      await user.click(thought);
    }
    expect(screen.getByText("Plan step 1")).toBeVisible();
    expect(screen.getByText("Plan step 2")).toBeVisible();
    expect(screen.getByText("Combine the findings")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /printf 'step 2'/ }));
    expect(screen.getByText("Output 2")).toBeVisible();

    rerender(turn({ ...row, endedAt: 1234 }));
    expect(process).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Output 2")).toBeVisible();
    expect(screen.getAllByText("Final response")).toHaveLength(1);
    const region = document.getElementById(process.getAttribute("aria-controls")!);
    expect(region).not.toContainElement(screen.getByText("Final response"));

    await user.click(process);
    expect(screen.queryByText("Progress update 1")).not.toBeInTheDocument();
    expect(screen.getByText("Final response")).toBeVisible();
    expect(screen.getByRole("separator")).toBeVisible();
  });

  it("opens a single activity group directly while keeping individual tool details collapsed", async () => {
    const user = userEvent.setup();
    const row = buildTranscriptRows([
      { role: "user", content: "Inspect the project" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: Array.from({ length: 6 }, (_, index) => [
          ...(index === 5 ? [{ type: "text", text: "<dcp-id>m013</dcp-id>" }] : []),
          {
            type: "toolCall",
            id: `step-${index + 1}`,
            name: "bash",
            arguments: { command: `echo step-${index + 1}` },
            status: "done",
            result: `Step ${index + 1} result`,
          },
        ]).flat(),
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Final response" }],
      },
    ])[1]!;
    render(turn(row));
    await user.click(screen.getByRole("button", { name: "Execution process · 6 actions" }));

    expect(screen.queryByRole("button", { name: /actions? completed/ })).not.toBeInTheDocument();
    const tools = screen.getAllByRole("button", { name: /echo step-/ });
    expect(tools).toHaveLength(6);
    for (const tool of tools) expect(tool).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Step \d result/)).not.toBeInTheDocument();

    await user.click(tools[0]!);
    expect(screen.getByText("Step 1 result")).toBeVisible();
    expect(tools[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Step 2 result")).not.toBeInTheDocument();
    expect(await screen.findByText("Final response")).toBeVisible();
  });

  it.each(["error", "aborted"])(
    "keeps the visible progress and open trace after %s",
    async (reason) => {
      const user = userEvent.setup();
      const { rerender } = render(turn(completedTurn(), true));
      const trace = screen.getAllByRole("button", { name: "1 action completed" })[0]!;
      await user.click(trace);
      await user.click(screen.getByRole("button", { name: /printf 'step 1'/ }));

      rerender(turn(completedTurn(2, reason)));
      expect(await screen.findByText("Progress update 1")).toBeVisible();
      expect(screen.getByText("Output 1")).toBeVisible();
      expect(screen.queryByRole("button", { name: /Execution process/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    },
  );

  it("keeps streaming text and pending tool work outside the completed process summary", async () => {
    const row = completedTurn();
    const { rerender } = render(turn(row, false, "streaming"));
    expect(await screen.findByText("Progress update 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Execution process/ })).not.toBeInTheDocument();
    const tool = row.blocks.find((block) => block.kind === "tool")!;
    if (tool.kind !== "tool") throw new Error("Missing tool fixture");
    tool.tool.status = "running";
    rerender(turn(row));
    expect(screen.getByText("Progress update 1")).toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("does not hide pending extension work behind a completed process summary", async () => {
    const row = completedTurn();
    const extension: TranscriptBlock = {
      kind: "extension",
      row: {
        key: "custom:pending",
        role: "custom",
        blocks: [],
        copyText: "",
        extensionPresentation: {
          version: 1,
          extensionId: "test-extension",
          audience: "agent",
          kind: "activity",
          status: "pending",
          correlationId: "pending-process-test",
        },
      },
    };
    row.sections!.ordered = [extension, ...row.sections!.ordered];
    render(turn(row));
    expect(await screen.findByText("Progress update 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Execution process/ })).not.toBeInTheDocument();
  });

  it("folds a thought-only process without displaying zero actions", async () => {
    const user = userEvent.setup();
    render(turn(completedTurn(0)));
    expect(await screen.findByText("Final response")).toBeVisible();
    const process = screen.getByRole("button", { name: "Execution process" });
    expect(screen.queryByText("Combine the findings")).not.toBeInTheDocument();
    await user.click(process);
    await user.click(screen.getByRole("button", { name: "Thought process" }));
    expect(screen.getByText("Combine the findings")).toBeVisible();
  });

  it("leaves a plain response and a turn without a final response in their existing layout", async () => {
    const plain = buildTranscriptRows([
      { role: "assistant", content: [{ type: "text", text: "Plain response" }] },
    ])[0]!;
    const { rerender } = render(turn(plain));
    expect(await screen.findByText("Plain response")).toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();

    const unfinished = completedTurn();
    const final = new Set(unfinished.sections!.final);
    unfinished.sections!.ordered = unfinished.sections!.ordered.filter(
      (block) => !final.has(block),
    );
    unfinished.sections!.final = [];
    rerender(turn(unfinished));
    expect(await screen.findByText("Progress update 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Execution process/ })).not.toBeInTheDocument();
  });

  it("keeps final images and provider blocks outside the process", async () => {
    const row = completedTurn();
    const image: TranscriptBlock = { kind: "image", mimeType: "image/png", data: "cGl4ZWw=" };
    const provider: TranscriptBlock = {
      kind: "unknown",
      type: "provider-data",
      value: { ok: true },
    };
    row.sections!.ordered.push(image, provider);
    row.sections!.final.push(image, provider);
    render(turn(row));
    expect(await screen.findByText("Final response")).toBeVisible();
    expect(screen.getByRole("img", { name: "Attachment" })).toBeVisible();
    expect(screen.getByText("provider-data")).toBeVisible();
  });

  it("localizes the approved process label and retains recovered tool failures in its summary", () => {
    useAppStore.setState({ desktopSettings: { language: "zh" } as never });
    const row = completedTurn(8);
    const { rerender } = render(turn(row));
    expect(screen.getByRole("button", { name: "执行过程 · 8 次操作" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const failed = row.blocks.find((block) => block.kind === "tool")!;
    if (failed.kind !== "tool") throw new Error("Missing tool fixture");
    failed.tool.status = "error";
    rerender(turn(row));
    expect(screen.getByRole("button", { name: "执行过程 · 8 次操作 · 1 次失败" })).toBeVisible();
  });
});
