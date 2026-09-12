/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAttachmentReferenceBlock,
  type HostStatusSnapshot,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { MenuHost } from "../../components/Menu";
import { PROGRESSIVE_BATCH_ROWS } from "./progressive-mount";
import * as progressiveMount from "./progressive-mount";
import { clearTranscriptScrollPositions } from "./transcript-scroll-memory";
import { buildAttachedFileBlock } from "./transcript-model";

const linkMocks = vi.hoisted(() => ({
  requestDockBrowser: vi.fn(),
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/dock-browser", () => ({
  requestDockBrowser: linkMocks.requestDockBrowser,
}));

vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: linkMocks.openSystemUrl,
}));

const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function longSession(sessionId: string, messageCount: number): SessionSnapshot {
  return {
    ...session(sessionId, "seed"),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: "user" as const,
      content: `Message ${index + 1}`,
    })),
  };
}

function session(sessionId: string, text: string): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: text }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

function processSession(): SessionSnapshot {
  return {
    ...session(SESSION_A, "Inspect the project"),
    messages: [
      { role: "user", content: "Inspect the project" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Check the files" },
          { type: "toolCall", id: "inspect", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "inspect",
        toolName: "bash",
        content: [{ type: "text", text: "README.md" }],
        isError: false,
      },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done" }] },
    ],
  };
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly elements = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.elements.add(element);
  }
  unobserve(element: Element) {
    this.elements.delete(element);
  }
  disconnect() {
    this.elements.clear();
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

let nextIdleId = 1;
let idleCallbacks = new Map<number, () => void>();

function flushIdle() {
  act(() => {
    const pending = [...idleCallbacks.values()];
    idleCallbacks.clear();
    pending.forEach((callback) => callback());
  });
}

/** Each flush runs one mount batch; loop until the idle queue settles. */
function flushIdleToConvergence(maxBatches = 60) {
  for (let batch = 0; batch < maxBatches && idleCallbacks.size > 0; batch++) {
    flushIdle();
  }
}

describe("Transcript Session-open scrolling", () => {
  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id);
      }),
    );
    nextIdleId = 1;
    idleCallbacks = new Map();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        const id = nextIdleId++;
        idleCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => {
        idleCallbacks.delete(id);
      }),
    );
    useAppStore.setState({
      page: "chat",
      session: session(SESSION_A, "First Session"),
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
    linkMocks.requestDockBrowser.mockReset().mockReturnValue(true);
    linkMocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
    clearTranscriptScrollPositions();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: Clipboard }).clipboard;
    useAppStore.setState({ session: null, desktopSettings: null });
  });

  function mockNavigationLayout(container: HTMLElement) {
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let top = 0;
    const mounted = () => [...container.querySelectorAll<HTMLElement>(".transcript-row")];
    Object.defineProperties(scroll, {
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, mounted().length * 40 - 100));
        },
      },
      scrollHeight: { configurable: true, get: () => mounted().length * 40 },
      clientHeight: { configurable: true, value: 100 },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = mounted().indexOf(this);
      return {
        top: index < 0 ? 0 : index * 40 - top,
        height: 40,
        left: 0,
        right: 36,
        width: 36,
        bottom: 40,
      } as DOMRect;
    });
    return scroll;
  }

  function mockProcessLayout(container: HTMLElement) {
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    const process = screen.getByRole("button", { name: "Execution process · 1 action" });
    const layout = { height: 1_000, processOffset: 740 };
    let top = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => layout.height },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, layout.height - 300));
        },
      },
    });
    vi.spyOn(process, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, layout.processOffset - top, 400, 32),
    );
    const content = container.querySelector("[data-transcript-content]")!;
    const observer = TestResizeObserver.instances.find((instance) =>
      instance.elements.has(content),
    )!;
    return { scroll, process, layout, resize: () => act(() => observer.trigger()) };
  }

  it("navigates to early history in batches beyond the automatic cap while retaining the tail and session", async () => {
    vi.spyOn(progressiveMount, "autoMountFloor").mockImplementation((count) =>
      Math.max(0, count - 80),
    );
    const request = vi.spyOn(hostClient, "request");
    const original = longSession(SESSION_A, 200);
    useAppStore.setState({ session: original });
    const { container } = render(<Transcript />);
    const scroll = mockNavigationLayout(container);
    flushFrames();
    const rail = screen.getByRole("listbox", { name: "Conversation minimap" });
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("Locating message");
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
    flushIdleToConvergence(80);
    flushFrames();
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(200);
    expect(screen.queryByText("Locating message...")).not.toBeInTheDocument();
    expect(scroll.scrollTop).toBe(0);
    expect(container.querySelector("[data-transcript-content]")).toHaveTextContent("Message 200");
    expect(useAppStore.getState().session).toEqual(original);
    expect(request).not.toHaveBeenCalled();
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(0);
  });

  it("replaces pending navigation and cancels it when the reader scrolls or changes sessions", () => {
    useAppStore.setState({ session: longSession(SESSION_A, 200) });
    const { container } = render(<Transcript />);
    const scroll = mockNavigationLayout(container);
    flushFrames();
    const rail = screen.getByRole("listbox", { name: "Conversation minimap" });
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "Enter" });
    fireEvent.keyDown(rail, { key: "End" });
    fireEvent.keyDown(rail, { key: "Enter" });
    flushIdle();
    flushFrames();
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
    expect(screen.queryByText("Locating message...")).not.toBeInTheDocument();
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "Enter" });
    fireEvent.wheel(scroll, { deltaY: -10 });
    expect(screen.queryByText("Locating message...")).not.toBeInTheDocument();
    fireEvent.keyDown(rail, { key: "Enter" });
    act(() => useAppStore.setState({ session: session(SESSION_B, "Different session") }));
    flushIdle();
    flushFrames();
    expect(screen.queryByRole("listbox", { name: "Conversation minimap" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(1);
    expect(screen.getByText("Different session")).toBeInTheDocument();
  });

  it("keeps navigation during branch extension and cancels it on an actual branch change", () => {
    const original = longSession(SESSION_A, 200);
    const entries = original.messages.map((message, index) => ({
      id: "entry" + index,
      parentId: index ? "entry" + (index - 1) : null,
      type: "message",
      message: { role: "user", content: "Message " + (index + 1) },
    }));
    useAppStore.setState({ session: { ...original, entries, leafId: "entry199" } });
    const { container } = render(<Transcript />);
    mockNavigationLayout(container);
    flushFrames();
    const rail = screen.getByRole("listbox", { name: "Conversation minimap" });
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "Enter" });
    const appended = [
      ...entries,
      {
        id: "entry200",
        parentId: "entry199",
        type: "message",
        message: { role: "user", content: "New prompt" },
      },
    ];
    act(() =>
      useAppStore.setState({ session: { ...original, entries: appended, leafId: "entry200" } }),
    );
    expect(rail).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Locating message");
    act(() =>
      useAppStore.setState({
        session: {
          ...original,
          messages: original.messages.slice(0, 5),
          entries: entries.slice(0, 5),
          leafId: "entry4",
        },
      }),
    );
    flushIdle();
    flushFrames();
    expect(rail).not.toBeInTheDocument();
    expect(screen.queryByText("Locating message...")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(5);
  });

  it("keeps a newly opened Session at the bottom through late content growth", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 900;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    flushFrames();
    expect(scroll.scrollTop).toBe(900);

    scrollHeight = 1_400;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
  });

  it("stops following manual history reads and resets to the bottom for the next Session", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    flushFrames();

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scrollHeight = 1_300;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(100);

    scrollHeight = 1_700;
    act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
    flushFrames();
    expect(scroll.scrollTop).toBe(1_700);
  });

  it("releases a small upward gesture before a queued tail alignment", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    flushFrames();

    expect(scroll.scrollTop).toBe(680);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();

    scroll.scrollTop = 695;
    fireEvent.scroll(scroll);
    scrollHeight = 1_100;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(800);
  });

  it("keeps following when content shrinkage lowers the maximum scroll position", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    scrollHeight = 900;
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    scrollHeight = 950;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();

    expect(scroll.scrollTop).toBe(650);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it.each(["pointer", "Enter", "Space"])(
    "keeps a process disclosure in place during expansion via %s, even with a queued tail alignment",
    async (activation) => {
      // Advance event delays explicitly so parallel DOM tests cannot starve
      // keyboard activation. Animation frames remain under flushFrames control.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      useAppStore.setState({ session: processSession() });
      const { container } = render(<Transcript />);
      const { scroll, process, layout, resize } = mockProcessLayout(container);
      flushFrames();
      const originalTop = process.getBoundingClientRect().top;
      expect(scroll.scrollTop).toBe(700);
      resize();

      if (activation !== "pointer") process.focus();
      const interaction =
        activation === "pointer"
          ? user.click(process)
          : user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      await vi.runAllTimersAsync();
      await interaction;
      expect(process).toHaveAttribute("aria-expanded", "true");

      for (const height of [1_200, 1_600]) {
        layout.height = height;
        // Native scroll anchoring can keep the final answer at the bottom as
        // the disclosure animates. The clicked header must stay in place.
        scroll.scrollTop = height - 300;
        fireEvent.scroll(scroll);
        resize();
        flushFrames();
        expect(scroll.scrollTop).toBe(700);
        expect(process.getBoundingClientRect().top).toBe(originalTop);
      }
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    },
  );

  it("lets manual scrolling release the disclosure anchor and resume following near the bottom", () => {
    useAppStore.setState({ session: processSession() });
    const { container } = render(<Transcript />);
    const { scroll, process, layout, resize } = mockProcessLayout(container);
    flushFrames();
    fireEvent.click(process);
    layout.height = 1_600;
    resize();
    flushFrames();

    fireEvent.wheel(scroll, { deltaY: -50 });
    scroll.scrollTop = 650;
    fireEvent.scroll(scroll);
    resize();
    flushFrames();
    expect(scroll.scrollTop).toBe(650);

    fireEvent.wheel(scroll, { deltaY: 640 });
    scroll.scrollTop = 1_290;
    fireEvent.scroll(scroll);
    layout.height = 1_700;
    resize();
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it("lets jump to latest take over from an expanded process", () => {
    useAppStore.setState({ session: processSession() });
    const { container } = render(<Transcript />);
    const { scroll, process, layout, resize } = mockProcessLayout(container);
    Object.defineProperty(scroll, "scrollTo", {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        scroll.scrollTop = top ?? 0;
      },
    });
    flushFrames();
    fireEvent.click(process);
    layout.height = 1_600;
    resize();
    flushFrames();

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(1_300);
    layout.height = 1_700;
    resize();
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it("lets minimap navigation and a new session replace a disclosure anchor", () => {
    const original = processSession();
    original.messages.unshift({ role: "user", content: "Earlier prompt" });
    useAppStore.setState({ session: original });
    const { container } = render(<Transcript />);
    const { scroll, process, layout, resize } = mockProcessLayout(container);
    const firstRow = container.querySelector<HTMLElement>(".transcript-row")!;
    vi.spyOn(firstRow, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 100 - scroll.scrollTop, 400, 40),
    );
    flushFrames();
    fireEvent.click(process);
    layout.height = 1_600;
    resize();
    flushFrames();

    const rail = screen.getByRole("listbox", { name: "Conversation minimap" });
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "Enter" });
    flushFrames();
    expect(scroll.scrollTop).toBe(88);
    resize();
    flushFrames();
    expect(scroll.scrollTop).toBe(88);

    act(() => useAppStore.setState({ session: session(SESSION_B, "Next session") }));
    flushFrames();
    expect(scroll.scrollTop).toBe(1_300);
  });

  it("opens a row context menu and copies the complete message", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("First Session"));
  });

  it("adds Dock, external-browser, and copy actions when right-clicking a link", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const row = container.querySelector<HTMLElement>(".transcript-row")!;
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.textContent = "Documentation";
    row.append(link);

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Open in Dock" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open in external browser" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Open in Dock" }));
    expect(linkMocks.requestDockBrowser).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Open in external browser" }));
    expect(linkMocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/docs");

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/docs"));

    expect(row).toBeInTheDocument();
  });

  it("leaves development Shift-right-click available for the native menu", () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
      shiftKey: true,
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  describe("progressive mounting", () => {
    /** Fake metrics, then release the tail pin with an upward history read. */
    function unfollow(scroll: HTMLElement) {
      let scrollTop = 0;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 1_000 },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.max(0, Math.min(value, 700));
          },
        },
      });
      flushFrames();
      scroll.scrollTop = 650;
      fireEvent.scroll(scroll);
    }

    it("opens with only the tail mounted, then converges once the reader unpins", async () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 150) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(
        screen.getByRole("button", { name: "Show earlier messages (90 hidden)" }),
      ).toBeInTheDocument();

      unfollow(scroll);
      await waitFor(
        () => {
          flushIdleToConvergence();
          expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
        },
        { timeout: 10_000 },
      );
      expect(
        screen.queryByRole("button", { name: /Show earlier messages/ }),
      ).not.toBeInTheDocument();
    }, 15_000);

    it("yields idle mounting to a followed stream and converges after it settles", async () => {
      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: true, isIdle: false },
        }),
      );
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(idleCallbacks.size).toBe(0);
      flushIdleToConvergence();
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: false, isIdle: true },
        }),
      );
      unfollow(scroll);
      await waitFor(
        () => {
          flushIdleToConvergence();
          expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
        },
        { timeout: 10_000 },
      );
    }, 15_000);

    it("restores the reading position when switching back to a session", () => {
      const longA = longSession(SESSION_A, 150);
      act(() => useAppStore.setState({ session: longA }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      unfollow(scroll);
      expect(scroll.scrollTop).toBe(650);

      act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
      flushFrames();
      expect(scroll.scrollTop).toBe(700);

      act(() => useAppStore.setState({ session: longA }));
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(scroll.scrollTop).toBe(650);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
    });

    it("mounts the next batch synchronously when the reader nears the top edge", () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 300) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 2_000 },
        scrollTop: { configurable: true, writable: true, value: 500 },
      });
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      fireEvent.scroll(scroll);

      // One synchronous boost batch at the initial adaptive size.
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(
        60 + PROGRESSIVE_BATCH_ROWS,
      );
    });
  });
});

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function hostStatus(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspaceStatus(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function branchedSession(): SessionSnapshot {
  return {
    ...session(SESSION_A, "Hello"),
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "Hello" },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      },
    ],
    leafId: "a1",
  };
}

function attachedFileSession(): SessionSnapshot {
  const content = ["Review this", buildAttachedFileBlock("notes.txt", "hello from disk")].join(
    "\n\n",
  );
  return {
    ...session(SESSION_A, content),
    messages: [
      { role: "user", content },
      { role: "assistant", content: [{ type: "text", text: "Reviewed" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Reviewed" }] },
      },
    ],
    leafId: "a1",
  };
}

function documentOnlySession(): SessionSnapshot {
  const content = buildAttachmentReferenceBlock([
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "manual.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      status: "ready",
      unit: "page",
      unitCount: 12,
    },
  ]);
  return {
    ...session(SESSION_A, content),
    messages: [
      { role: "user", content },
      { role: "assistant", content: [{ type: "text", text: "Read the PDF" }] },
    ],
    entries: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Read the PDF" }] },
      },
    ],
    leafId: "a1",
  };
}

describe("Transcript edit and regenerate", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    useAppStore.getState().setHost(hostStatus());
    useAppStore.getState().setWorkspace(workspaceStatus());
    useAppStore.getState().applySessionSnapshot(branchedSession());
    useAppStore.setState({
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.setState({ desktopSettings: null });
  });

  it("edits a user message in place and only prompts after send", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: {
        accepted: true,
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        session: branchedSession(),
      },
    } as never);
    render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(request).not.toHaveBeenCalled();
    const editor = screen.getByRole("textbox", { name: "Edit" });
    expect(editor).toHaveValue("Hello");
    fireEvent.change(editor, { target: { value: "Hello again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        { text: "Hello again", fromEntryId: "u1" },
        null,
      ),
    );
  });

  it("regenerates an assistant turn from the preceding user entry", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        { text: "Hello", fromEntryId: "u1" },
        null,
      ),
    );
  });

  it("re-attaches a text file when regenerating", async () => {
    useAppStore.getState().applySessionSnapshot(attachedFileSession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: ["Review this", buildAttachedFileBlock("notes.txt", "hello from disk")].join(
            "\n\n",
          ),
          fromEntryId: "u1",
        },
        null,
      ),
    );
  });

  it("re-attaches a text file when editing and sending", async () => {
    useAppStore.getState().applySessionSnapshot(attachedFileSession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit" }), {
      target: { value: "Please review again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: [
            "Please review again",
            buildAttachedFileBlock("notes.txt", "hello from disk"),
          ].join("\n\n"),
          fromEntryId: "u1",
        },
        null,
      ),
    );
  });

  it("regenerates a document-only message with attachment ids", async () => {
    useAppStore.getState().applySessionSnapshot(documentOnlySession());
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1,
      id: "req",
      method: "agent.prompt",
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: SESSION_A,
      sessionRevision: 1,
      packageRevision: 1,
      ok: true,
      result: { accepted: true, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    } as never);
    render(<Transcript />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.any(Object),
        {
          text: "",
          fromEntryId: "u1",
          attachmentIds: ["11111111-1111-4111-8111-111111111111"],
        },
        null,
      ),
    );
  });

  it("offers edit on the user-row context menu", async () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const userRow = container.querySelectorAll(".transcript-row")[0]!;
    fireEvent.contextMenu(userRow, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
