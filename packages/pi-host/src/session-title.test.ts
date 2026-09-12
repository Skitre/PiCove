import { describe, expect, it, vi } from "vitest";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  createProvisionalSessionTitle,
  extractFirstUserText,
  extractLatestAssistantText,
  generateRefinedSessionTitle,
  sanitizeSessionTitle,
} from "./session-title.js";

describe("session titles", () => {
  it("creates a concise provisional title from the first sentence", () => {
    expect(createProvisionalSessionTitle("修复 session 恢复问题。然后补测试")).toBe(
      "修复 session 恢复问题",
    );
    expect(createProvisionalSessionTitle("   ")).toBe("新会话");
  });

  it("cleans model labels, quotes, punctuation, and excessive length", () => {
    expect(sanitizeSessionTitle('标题："修复桌面会话恢复。"')).toBe("修复桌面会话恢复");
    expect(sanitizeSessionTitle("a".repeat(40))).toBe(`${"a".repeat(27)}…`);
  });

  it("extracts the latest assistant text blocks", () => {
    expect(
      extractLatestAssistantText([
        { role: "assistant", content: "old" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  it("extracts the first visible user text without attachment metadata or image data", () => {
    const attachments = '<pideck-attachments version="1">[]</pideck-attachments>';
    expect(
      extractFirstUserText([
        null,
        { role: "assistant", content: "ignored" },
        { role: "user", content: attachments },
        {
          role: "user",
          content: [
            { type: "image", data: "ignored" },
            { type: "text", text: `Summarize this document\n${attachments}` },
          ],
        },
        { role: "user", content: "later task" },
      ]),
    ).toBe("Summarize this document");
    expect(extractFirstUserText([{ role: "user", content: "Plain text" }])).toBe("Plain text");
    expect(
      extractFirstUserText([{ role: "user", content: [{ type: "image", data: "ignored" }] }]),
    ).toBe("");
  });

  it("uses a separate minimal completion and sanitizes its result", async () => {
    const complete = vi.fn(
      async (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) =>
        ({
          role: "assistant",
          content: [{ type: "text", text: "Title: Restore desktop sessions." }],
          stopReason: "stop",
        }) as AssistantMessage,
    );
    const model = { provider: "test", id: "title", api: "test" } as Model<Api>;
    const signal = new AbortController().signal;
    const title = await generateRefinedSessionTitle({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
      userPrompt: "Restore desktop sessions",
      assistantText: "Implemented session restoration.",
      signal,
      complete,
    });

    expect(title).toBe("Restore desktop sessions");
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "test-key",
      maxTokens: 64,
      maxRetries: 0,
      reasoning: "minimal",
      timeoutMs: 15_000,
      signal,
    });
  });

  it.each(["", "   ", "Title:"])(
    "rejects empty model output %j instead of using a fallback",
    async (text) => {
      await expect(
        generateRefinedSessionTitle({
          model: { provider: "test", id: "title", api: "test" } as Model<Api>,
          modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
          userPrompt: "Original request",
          assistantText: "Reply",
          complete: async () =>
            ({
              role: "assistant",
              content: [{ type: "text", text }],
              stopReason: "stop",
            }) as AssistantMessage,
        }),
      ).rejects.toThrow("The model did not return a title");
    },
  );

  it("reports credential failure before attempting a completion", async () => {
    const complete = vi.fn();
    await expect(
      generateRefinedSessionTitle({
        model: { provider: "test", id: "title", api: "test" } as Model<Api>,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: false, error: "No credentials" }),
        },
        userPrompt: "Original request",
        assistantText: "",
        complete,
      }),
    ).rejects.toThrow("No credentials");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted"] as const)(
    "rejects a completion that stopped with %s",
    async (stopReason) => {
      await expect(
        generateRefinedSessionTitle({
          model: { provider: "test", id: "title", api: "test" } as Model<Api>,
          modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
          userPrompt: "Original request",
          assistantText: "",
          complete: async () =>
            ({ role: "assistant", content: [], stopReason }) as unknown as AssistantMessage,
        }),
      ).rejects.toThrow(`Title generation ${stopReason}`);
    },
  );
});
