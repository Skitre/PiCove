/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionWidgetRows, type ExtensionWidgetActionDispatch } from "./ExtensionWidgetContent";

function structuredWidget() {
  return {
    pideck: 1 as const,
    rows: [
      { kind: "text" as const, text: "3 agents running", tone: "muted" as const },
      {
        kind: "fields" as const,
        fields: [
          { label: "Queued", value: "2" },
          { label: "Failed", value: "0" },
        ],
      },
      { kind: "progress" as const, value: 3, max: 8, label: "Fleet" },
      {
        kind: "actions" as const,
        actions: [
          { id: "open", label: "Open", style: "primary" as const },
          { id: "disabled", label: "Disabled", disabled: true },
        ],
      },
    ],
  };
}

beforeEach(() => {
  useAppStore.setState({
    collapsedExtensionWidgetKeys: {},
    desktopSettings: null,
    surfaceLanguage: "en",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("structured Extension widgets", () => {
  it("supports controlled collapse state for a detached window", async () => {
    const onToggleCollapsed = vi.fn();
    const { rerender } = render(
      <ExtensionWidgetRows
        widgets={[{ key: "fleet", widget: ["ready"] }]}
        form="panel"
        collapsedWidgetKeys={{}}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Collapse extension widget fleet" }));
    expect(onToggleCollapsed).toHaveBeenCalledWith("fleet");
    expect(screen.getByText("ready")).toBeInTheDocument();

    rerender(
      <ExtensionWidgetRows
        widgets={[{ key: "fleet", widget: ["ready"] }]}
        form="panel"
        collapsedWidgetKeys={{ fleet: true }}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    expect(screen.getByRole("button", { name: "Expand extension widget fleet" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("ready")).toBeNull();
  });

  it("renders semantic rows and host-owned controls", () => {
    render(
      <ExtensionWidgetRows
        widgets={[{ key: "fleet", widget: structuredWidget() }]}
        form="panel"
        onAction={vi.fn(async () => null)}
      />,
    );

    expect(screen.getByText("3 agents running")).toHaveClass("text-muted");
    expect(screen.getByText("Queued").tagName).toBe("DT");
    expect(screen.getByText("2").tagName).toBe("DD");
    expect(screen.getByRole("progressbar", { name: "Fleet" })).toHaveAttribute(
      "aria-valuenow",
      "3",
    );
    expect(screen.getByRole("progressbar", { name: "Fleet" })).toHaveAttribute(
      "aria-valuemax",
      "8",
    );
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
    expect(document.querySelector("[data-extension-structured-widget]")).not.toBeNull();
  });

  it("keeps one action pending and disables sibling actions while it runs", async () => {
    let finish: ((value: string | null) => void) | undefined;
    const onAction: ExtensionWidgetActionDispatch = vi.fn(
      () => new Promise<string | null>((resolve) => (finish = resolve)),
    );
    render(
      <ExtensionWidgetRows
        widgets={[{ key: "fleet", widget: structuredWidget() }]}
        form="panel"
        onAction={onAction}
      />,
    );

    const open = screen.getByRole("button", { name: "Open" });
    await userEvent.click(open);
    expect(onAction).toHaveBeenCalledWith("fleet", "open");
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute("aria-busy", "true");
    await act(async () => finish?.(null));
    await waitFor(() => expect(open).toBeEnabled());
    expect(open).not.toHaveAttribute("aria-busy");
  });

  it("uses the shared danger dialog before a confirmed action", async () => {
    const onAction = vi.fn(async () => null);
    render(
      <ExtensionWidgetRows
        widgets={[
          {
            key: "fleet",
            widget: {
              pideck: 1,
              rows: [
                {
                  kind: "actions",
                  actions: [
                    {
                      id: "stop",
                      label: "Stop all",
                      style: "danger",
                      confirm: "Stop every agent?",
                    },
                  ],
                },
              ],
            },
          },
        ]}
        form="panel"
        onAction={onAction}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Stop all" }));
    expect(onAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Confirm Stop all" });
    expect(within(dialog).getByText("Stop every agent?")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Stop all" }));
    expect(onAction).toHaveBeenCalledWith("fleet", "stop");
  });

  it("falls back to the existing read-only renderer for a newer version", () => {
    render(
      <ExtensionWidgetRows
        widgets={[
          {
            key: "future",
            widget: { pideck: 2, rows: [{ kind: "actions", actions: [{ id: "x", label: "X" }] }] },
          },
        ]}
        form="panel"
        onAction={vi.fn(async () => null)}
      />,
    );

    expect(document.querySelector("[data-extension-structured-widget]")).toBeNull();
    expect(screen.queryByRole("button", { name: "X" })).toBeNull();
    expect(document.querySelector("pre")).toHaveTextContent('"pideck": 2');
  });
});
