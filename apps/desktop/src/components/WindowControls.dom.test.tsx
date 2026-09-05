/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowControls,
  resolveWindowControlsPlatform,
  shouldRenderWindowControls,
} from "./WindowControls";

const windowApi = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  setSimpleFullscreen: vi.fn(async (_fullscreen: boolean) => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("resolveWindowControlsPlatform", () => {
  it("prefers the Tauri build platform and falls back to the browser user agent", () => {
    expect(resolveWindowControlsPlatform("darwin", "Windows")).toBe("macos");
    expect(resolveWindowControlsPlatform("macos", "Windows")).toBe("macos");
    expect(resolveWindowControlsPlatform("windows", "Macintosh")).toBe("windows");
    expect(resolveWindowControlsPlatform(undefined, "Mozilla/5.0 (Macintosh)")).toBe("macos");
    expect(resolveWindowControlsPlatform(undefined, "Mozilla/5.0 (Windows NT 10.0)")).toBe(
      "windows",
    );
  });
});

describe("shouldRenderWindowControls", () => {
  it("hides only macOS traffic lights while the settings overlay is open", () => {
    expect(shouldRenderWindowControls("macos", true)).toBe(false);
    expect(shouldRenderWindowControls("macos", false)).toBe(true);
    expect(shouldRenderWindowControls("windows", true)).toBe(true);
    expect(shouldRenderWindowControls("windows", false)).toBe(true);
  });
});

describe("WindowControls", () => {
  it("renders macOS traffic lights at the top-left in native action order", () => {
    render(<WindowControls platform="macos" macosFullscreen={false} />);

    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(controls).toHaveAttribute("data-window-controls-platform", "macos");
    expect(controls).toHaveClass("left-1.5", "top-1.5");
    expect(
      within(controls)
        .getAllByRole("button")
        .map((button) => button.ariaLabel),
    ).toEqual(["Close window", "Minimize window", "Enter or exit fullscreen"]);
    expect(
      within(controls).getByRole("button", { name: "Close window" }).firstElementChild,
    ).toHaveClass("mac-window-control-dot--close");
    expect(
      within(controls).getByRole("button", { name: "Minimize window" }).firstElementChild,
    ).toHaveClass("mac-window-control-dot--minimize");
    expect(
      within(controls).getByRole("button", { name: "Enter or exit fullscreen" }).firstElementChild,
    ).toHaveClass("mac-window-control-dot--maximize");
  });

  it("aligns the Windows controls with the chat header in native action order", () => {
    render(<WindowControls platform="windows" />);

    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(controls).toHaveAttribute("data-window-controls-platform", "windows");
    expect(controls).toHaveClass("right-0", "top-0");
    const buttons = within(controls).getAllByRole("button");
    expect(buttons.map((button) => button.ariaLabel)).toEqual([
      "Minimize window",
      "Maximize or restore window",
      "Close window",
    ]);
    expect(
      buttons.every((button) => button.classList.contains("h-[var(--theme-toolbar-height)]")),
    ).toBe(true);
  });

  it("routes macOS traffic-light clicks through the shared Tauri window actions", async () => {
    const onFullscreenTransition = vi.fn();
    const onFullscreenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WindowControls
        platform="macos"
        macosFullscreen={false}
        onMacosFullscreenTransition={onFullscreenTransition}
        onMacosFullscreenChange={onFullscreenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close window" }));
    await user.click(screen.getByRole("button", { name: "Minimize window" }));
    await user.click(screen.getByRole("button", { name: "Enter or exit fullscreen" }));

    await waitFor(() => {
      expect(windowApi.close).toHaveBeenCalledOnce();
      expect(windowApi.minimize).toHaveBeenCalledOnce();
      expect(onFullscreenTransition).toHaveBeenCalledWith(true);
      expect(onFullscreenChange).toHaveBeenCalledWith(true);
      expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
    });
  });

  it("exits fullscreen from the macOS green control when already fullscreen", async () => {
    const onFullscreenChange = vi.fn();
    const onFullscreenTransition = vi.fn();
    const user = userEvent.setup();
    render(
      <WindowControls
        platform="macos"
        macosFullscreen
        onMacosFullscreenTransition={onFullscreenTransition}
        onMacosFullscreenChange={onFullscreenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enter or exit fullscreen" }));

    await waitFor(() => {
      expect(onFullscreenTransition).toHaveBeenCalledWith(false);
      expect(onFullscreenChange).toHaveBeenCalledWith(false);
    });
  });

  it("keeps the Windows caption button on maximize and restore", async () => {
    const user = userEvent.setup();
    render(<WindowControls platform="windows" />);

    await user.click(screen.getByRole("button", { name: "Maximize or restore window" }));

    await waitFor(() => {
      expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
      expect(windowApi.setSimpleFullscreen).not.toHaveBeenCalled();
    });
  });

  it("rolls back the macOS fullscreen state when the native call fails", async () => {
    const onFullscreenChange = vi.fn();
    const onFullscreenTransition = vi.fn();
    onFullscreenTransition.mockRejectedValueOnce(new Error("native failure"));
    const user = userEvent.setup();
    render(
      <WindowControls
        platform="macos"
        macosFullscreen={false}
        onMacosFullscreenTransition={onFullscreenTransition}
        onMacosFullscreenChange={onFullscreenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enter or exit fullscreen" }));

    await waitFor(() => {
      expect(onFullscreenTransition).toHaveBeenNthCalledWith(1, true);
      expect(onFullscreenTransition).toHaveBeenNthCalledWith(2, null);
      expect(onFullscreenChange).toHaveBeenCalledWith(false);
    });
  });

  it("uses simple fullscreen directly when no transition handler is provided", async () => {
    const user = userEvent.setup();
    render(<WindowControls platform="macos" />);

    await user.click(screen.getByRole("button", { name: "Enter or exit fullscreen" }));

    await waitFor(() => {
      expect(windowApi.setSimpleFullscreen).toHaveBeenCalledWith(true);
    });
  });
});
