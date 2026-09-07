/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptMinimap } from "./TranscriptMinimap";
import type { TranscriptTurn } from "./transcript-minimap-model";
import { useAppStore } from "../../lib/stores/app-store";
import { isBrowserOccluded, resetBrowserOcclusionForTests } from "../../lib/browser-occlusion";

const navigate = vi.fn();
const turns: TranscriptTurn[] = Array.from({ length: 1000 }, (_, index) => ({
  key: "u" + index,
  rowIndex: index * 2,
  user: { key: "u" + index, role: "user", blocks: [], copyText: "Question " + index },
  reply: {
    key: "a" + index,
    role: "assistant",
    blocks: [{ kind: "text", text: "Answer " + index }],
    copyText: "Answer " + index,
  },
}));
const originalScrollTo = HTMLElement.prototype.scrollTo;

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  if (!elements.current.size)
    turns.forEach((turn, index) => {
      const element = document.createElement("div");
      element.getBoundingClientRect = () =>
        ({ top: index * 100 - (scrollRef.current?.scrollTop ?? 0) }) as DOMRect;
      elements.current.set(turn.key, element);
    });
  return (
    <div>
      <div ref={scrollRef} data-scroll>
        <div ref={contentRef} />
      </div>
      <TranscriptMinimap
        turns={turns}
        scrollRef={scrollRef}
        contentRef={contentRef}
        rowElements={elements}
        hidden={0}
        working={false}
        pendingKey={null}
        onNavigate={navigate}
      />
      <button>Outside</button>
    </div>
  );
}

beforeEach(() => {
  navigate.mockReset();
  useAppStore.setState({
    desktopSettings: {
      theme: "light",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-transcript-minimap") ? 320 : 180;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(36);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(12000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      top: this.hasAttribute("data-transcript-minimap") ? 100 : 0,
      right: 44,
      left: 8,
      bottom: 420,
      width: 36,
      height: 320,
    } as DOMRect;
  });
  HTMLElement.prototype.scrollTo = function (options) {
    const next = typeof options === "object" ? (options.top ?? this.scrollTop) : (options ?? 0);
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  resetBrowserOcclusionForTests();
});

async function open() {
  const result = render(<Harness />);
  const rail = screen.getByRole("listbox", { name: "Conversation minimap" });
  await waitFor(() => {
    expect(screen.getByRole("option", { name: "Turn 1" })).toHaveAttribute("aria-selected", "true");
    expect(rail.scrollTop).toBe(0);
  });
  return { ...result, rail };
}

describe("Transcript minimap", () => {
  it("virtualizes long lists and keeps idle lines equal before expanding near the pointer", async () => {
    const { rail } = await open();
    expect(screen.getAllByRole("option").length).toBeLessThan(40);
    expect(
      [...rail.querySelectorAll("span")].every(
        (line) => line.style.transform === "scaleX(" + 6 / 26 + ")",
      ),
    ).toBe(true);
    fireEvent.pointerMove(rail, { clientY: 100 + 4 * 12 + 6 });
    expect(screen.getByRole("option", { name: "Turn 5" }).firstChild).toHaveStyle({
      transform: "scaleX(1)",
    });
    expect(screen.getByRole("option", { name: "Turn 4" }).firstChild).toHaveStyle({
      transform: "scaleX(" + 20 / 26 + ")",
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Question 4");
    expect(isBrowserOccluded()).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: "Turn 5" }));
    expect(navigate).toHaveBeenCalledWith("u4");
  });

  it("keeps the preview across the pointer gap and releases occlusion after leaving", async () => {
    const { rail } = await open();
    fireEvent.pointerMove(rail, { clientY: 106 });
    const preview = await screen.findByRole("tooltip");
    fireEvent.pointerLeave(rail);
    fireEvent.pointerEnter(preview);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(preview).toBeInTheDocument();
    fireEvent.pointerLeave(preview);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(isBrowserOccluded()).toBe(false);
    });
    expect(
      [...rail.querySelectorAll("span")].every(
        (line) => line.style.transform === "scaleX(" + 6 / 26 + ")",
      ),
    ).toBe(true);
  });

  it("supports keyboard traversal through unmounted nodes without navigating until activation", async () => {
    const { rail } = await open();
    act(() => rail.focus());
    fireEvent.keyDown(rail, { key: "End" });
    await screen.findByRole("option", { name: "Turn 1000" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Question 999");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(rail, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("u999");
    fireEvent.keyDown(rail, { key: "Home" });
    await screen.findByRole("option", { name: "Turn 1" });
    fireEvent.keyDown(rail, { key: "ArrowDown" });
    fireEvent.keyDown(rail, { key: " " });
    expect(navigate).toHaveBeenLastCalledWith("u1");
    fireEvent.keyDown(rail, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(rail).toHaveFocus();
  });

  it("tracks reading position without taking over the rail during independent browsing", async () => {
    const { rail, container } = await open();
    const scroll = container.querySelector<HTMLElement>("[data-scroll]")!;
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Turn 4" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    fireEvent.pointerEnter(rail);
    scroll.scrollTop = 90000;
    fireEvent.scroll(scroll);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(rail.scrollTop).toBe(0);
  });
});
