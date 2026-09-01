/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu, openContextMenu } from "../lib/context-menu";
import { MenuHost } from "./Menu";

afterEach(() => {
  closeContextMenu();
  cleanup();
  vi.restoreAllMocks();
});

describe("MenuHost", () => {
  it("focuses enabled items, supports roving keys, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    render(<MenuHost />);

    act(() => {
      openContextMenu({
        x: 20,
        y: 30,
        trigger,
        items: [
          { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { id: "first", label: "First", onSelect: vi.fn() },
          { id: "second", label: "Second", onSelect: vi.fn() },
        ],
      });
    });

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("runs one selected action and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const action = vi.fn();
    render(<MenuHost />);
    act(() => {
      openContextMenu({
        x: 0,
        y: 0,
        trigger,
        items: [{ id: "run", label: "Run", onSelect: action }],
      });
    });
    await user.click(await screen.findByRole("menuitem", { name: "Run" }));
    expect(action).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("starts a fresh focus cycle when another surface replaces the open menu", async () => {
    const firstTrigger = document.createElement("button");
    const secondTrigger = document.createElement("button");
    document.body.append(firstTrigger, secondTrigger);
    render(<MenuHost />);
    act(() => {
      openContextMenu({
        x: 10,
        y: 10,
        trigger: firstTrigger,
        items: [{ id: "first", label: "First", onSelect: vi.fn() }],
      });
    });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus());
    act(() => {
      openContextMenu({
        x: 40,
        y: 50,
        trigger: secondTrigger,
        items: [{ id: "second", label: "Second", onSelect: vi.fn() }],
      });
    });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus());
    expect(screen.queryByRole("menuitem", { name: "First" })).not.toBeInTheDocument();
  });

  it("renders compact density and marks the current item without focusing it", async () => {
    render(<MenuHost />);
    act(() => {
      openContextMenu({
        x: 10,
        y: 10,
        trigger: null,
        density: "compact",
        items: [
          {
            id: "current",
            label: "Current",
            selected: true,
            disabled: true,
            onSelect: vi.fn(),
          },
          { id: "next", label: "Next", onSelect: vi.fn() },
        ],
      });
    });

    expect(screen.getByRole("menu")).toHaveAttribute("data-menu-density", "compact");
    expect(screen.getByRole("menuitem", { name: "Current" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Next" })).toHaveFocus());
  });
});
