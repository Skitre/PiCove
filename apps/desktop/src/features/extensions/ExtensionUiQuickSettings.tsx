import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Search, SlidersHorizontal, X } from "lucide-react";
import type { PresentationHome } from "@pideck/protocol";
import { MAX_EXTENSION_UI_FLOATS } from "@pideck/protocol";
import { Switch } from "../../components/Switch";
import { secondaryButton } from "../../components/Dialog";
import { useBrowserOcclusion } from "../../lib/browser-occlusion";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import {
  canonicalExtensionUiSettings,
  notifyDesktopSettingsSaveFailure,
} from "../../lib/desktop-settings";
import { commitExtensionPresentationHome } from "../../lib/extension-ui-profile";
import {
  canCreateLiveExtensionFloat,
  useLiveExtensionPresentationSlots,
} from "../../lib/extension-ui-live-slots";
import { countLiveFloatMounts } from "../../lib/extension-ui-slots";
import { observedExtensionDisplayName } from "../../lib/extension-ui-observation";
import {
  extensionUiChoiceMessageKey,
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "../../lib/extension-ui-home-message";
import {
  FAMILY_PRESENTATION_CHOICES,
  isLegalPresentationChoice,
  presentationChoiceFromHome,
  presentationHomeFromChoice,
} from "../../lib/extension-ui-presentation";

const QUICK_FAMILIES = ["widget", "status", "custom"] as const;
type QuickFamily = (typeof QUICK_FAMILIES)[number];
type HomeChange = { choice: string } | { pinned: boolean };
type PanelSize = { width: number; height?: number; rightOffset?: number; topOffset?: number };
const RESIZE_EDGES = {
  n: "inset-x-3 top-0 h-1.5 cursor-n-resize",
  s: "inset-x-3 bottom-0 h-1.5 cursor-s-resize",
  w: "inset-y-3 left-0 w-1.5 cursor-w-resize",
  e: "inset-y-3 right-0 w-1.5 cursor-e-resize",
  nw: "left-0 top-0 size-3 cursor-nw-resize",
  ne: "right-0 top-0 size-3 cursor-ne-resize",
  sw: "left-0 bottom-0 size-3 cursor-sw-resize",
  se: "right-0 bottom-0 size-3 cursor-se-resize",
} as const;
type ResizeEdge = keyof typeof RESIZE_EDGES;
const DEFAULT_PANEL_SIZE: PanelSize = { width: 340 };
const iconButton =
  "flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function extensionQuickPanelPosition(
  anchor: Pick<DOMRect, "right" | "bottom">,
  viewportWidth: number,
  viewportHeight: number,
  size: PanelSize = DEFAULT_PANEL_SIZE,
) {
  const right = Math.min(viewportWidth - 12, anchor.right + (size.rightOffset ?? 0));
  const maxWidth = Math.max(0, Math.min(viewportWidth - 24, Math.max(280, right - 12)));
  const width = Math.min(Math.max(280, size.width), maxWidth);
  const top = Math.max(
    12,
    Math.min(anchor.bottom + 6 + (size.topOffset ?? 0), viewportHeight - 12),
  );
  const availableHeight = Math.max(0, viewportHeight - top - 12);
  return {
    width,
    left: Math.max(12, Math.min(right - width, viewportWidth - width - 12)),
    top,
    height:
      size.height === undefined ? undefined : Math.min(Math.max(240, size.height), availableHeight),
    maxHeight: size.height === undefined ? Math.min(560, availableHeight) : availableHeight,
  };
}

function QuickPanel({
  id,
  triggerRef,
  saving,
  error,
  size,
  onResize,
  onClose,
  onChange,
}: {
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  saving: boolean;
  error: string;
  size: PanelSize;
  onResize: (size: PanelSize) => void;
  onClose: (restoreFocus?: boolean) => void;
  onChange: (extensionId: string, family: QuickFamily, change: HomeChange) => Promise<void>;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pointerInside = useRef(false);
  const resizeStart = useRef<{
    pointerId: number;
    edge: ResizeEdge;
    x: number;
    y: number;
    rect: DOMRect;
    rightOffset: number;
    topOffset: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(() =>
    extensionQuickPanelPosition(
      triggerRef.current?.getBoundingClientRect() ?? { right: window.innerWidth - 12, bottom: 44 },
      window.innerWidth,
      window.innerHeight,
      size,
    ),
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBrowserOcclusion("extension-ui-quick:" + id);
  const desktopSettings = useAppStore((state) => state.desktopSettings);
  const settings = canonicalExtensionUiSettings(desktopSettings);
  const slots = useLiveExtensionPresentationSlots();
  const liveIds = new Set(slots.map((slot) => slot.extensionId));
  const floatCount = countLiveFloatMounts(slots);
  const extensions = Object.entries(settings.observedCapabilities)
    .filter(([, observed]) => QUICK_FAMILIES.some((family) => observed.families.includes(family)))
    .map(([extensionId, observed]) => ({
      extensionId,
      observed,
      name: observedExtensionDisplayName(extensionId),
    }))
    .sort(
      (left, right) =>
        Number(liveIds.has(right.extensionId)) - Number(liveIds.has(left.extensionId)) ||
        right.observed.lastSeenAt - left.observed.lastSeenAt ||
        left.extensionId.localeCompare(right.extensionId),
    );
  const search = query.trim().toLocaleLowerCase();
  const matching = extensions.filter(
    ({ extensionId, name }) =>
      name.toLocaleLowerCase().includes(search) || extensionId.toLocaleLowerCase().includes(search),
  );

  useLayoutEffect(() => {
    let frame = 0;
    // Follow position-only changes too, including sidebar and Dock transitions.
    const followAnchor = () => {
      const anchor = triggerRef.current;
      if (anchor) {
        const next = extensionQuickPanelPosition(
          anchor.getBoundingClientRect(),
          window.innerWidth,
          window.innerHeight,
          size,
        );
        setPosition((previous) =>
          previous.left === next.left &&
          previous.top === next.top &&
          previous.width === next.width &&
          previous.height === next.height &&
          previous.maxHeight === next.maxHeight
            ? previous
            : next,
        );
      }
      frame = requestAnimationFrame(followAnchor);
    };
    followAnchor();
    return () => cancelAnimationFrame(frame);
  }, [triggerRef, size]);

  function resize(next: PanelSize) {
    const anchor = triggerRef.current;
    if (!anchor) return;
    const bounded = extensionQuickPanelPosition(
      anchor.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
      next,
    );
    onResize({ ...next, width: bounded.width, height: bounded.height });
  }

  useEffect(() => {
    searchRef.current?.focus();
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (event.type === "focusin" && pointerInside.current && target === document.body) return;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target))
        closeRef.current(false);
    };
    const finishPointer = () => {
      pointerInside.current = false;
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("pointerup", finishPointer);
    document.addEventListener("pointercancel", finishPointer);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("pointerup", finishPointer);
      document.removeEventListener("pointercancel", finishPointer);
    };
  }, [triggerRef]);

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      tabIndex={-1}
      aria-labelledby={id + "-title"}
      data-extension-ui-quick-panel
      style={position}
      className="theme-floating-surface fixed z-[45] flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-foreground shadow-xl"
      onPointerDownCapture={() => {
        pointerInside.current = true;
      }}
      onBlur={(event) => {
        // A click on non-focusable panel content can blur to the document in WebKit.
        if (!event.relatedTarget && pointerInside.current) {
          event.currentTarget.focus({ preventScroll: true });
          return;
        }
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !triggerRef.current?.contains(event.relatedTarget)
        )
          onClose(false);
      }}
      onKeyDown={(event) => {
        pointerInside.current = false;
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <h2 id={id + "-title"} className="min-w-0 flex-1 truncate text-sm font-semibold">
          Extension UI
        </h2>
        <button
          type="button"
          className={iconButton}
          title={t("commonClose")}
          aria-label={t("commonClose")}
          onClick={() => onClose(true)}
        >
          <X size={15} />
        </button>
      </header>
      <div className="shrink-0 border-b border-border px-3 pb-3">
        <label className="relative block">
          <span className="sr-only">{t("extensionUiQuickSearch")}</span>
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t("extensionUiQuickSearch")}
            onChange={(event) => setQuery(event.target.value)}
            className="extension-ui-quick-search-input h-9 w-full min-w-0 rounded-md border border-border bg-surface pl-8 pr-2 text-xs outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={saving}>
        {matching.length === 0 ? (
          <p role="status" className="px-3 py-6 text-center text-xs text-muted">
            {t(extensions.length === 0 ? "extensionUiQuickEmpty" : "extensionUiQuickNoResults")}
          </p>
        ) : (
          matching.map(({ extensionId, name, observed }) => (
            <section
              key={extensionId}
              aria-label={name}
              data-extension-ui-quick-profile={extensionId}
              className="space-y-2 border-b border-border px-3 py-3 last:border-b-0"
            >
              <h3
                className="truncate text-xs font-semibold"
                title={name + " (" + extensionId + ")"}
              >
                {name}
              </h3>
              {QUICK_FAMILIES.filter((family) => observed.families.includes(family)).map(
                (family) => {
                  const home = settings.presentations[extensionId]?.[family]?.home;
                  const choice = presentationChoiceFromHome(family, home);
                  const label = t(extensionUiFamilyMessageKey(family));
                  const selectId = id + "-" + extensionId + "-" + family;
                  return (
                    <div key={family} className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)] items-center gap-3">
                        <label htmlFor={selectId} className="break-words text-xs text-muted">
                          {label}
                        </label>
                        <select
                          id={selectId}
                          aria-label={t("extensionUiPlacementMenu", { name, family: label })}
                          value={choice}
                          disabled={saving || !desktopSettings}
                          className="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-xs disabled:opacity-50"
                          onChange={(event) =>
                            void onChange(extensionId, family, { choice: event.target.value })
                          }
                        >
                          {FAMILY_PRESENTATION_CHOICES[family].map((option) => (
                            <option
                              key={option}
                              value={option}
                              disabled={
                                option === "float" &&
                                choice !== "float" &&
                                floatCount >= MAX_EXTENSION_UI_FLOATS
                              }
                            >
                              {t(extensionUiChoiceMessageKey(option))}
                            </option>
                          ))}
                        </select>
                      </div>
                      {home?.kind === "float" && (
                        <div className="flex items-center justify-end gap-2 text-xs text-muted">
                          <span>{t("extensionUiQuickPin")}</span>
                          <Switch
                            checked={home.pinned === true}
                            label={t("extensionUiFloatPin", { name, family: label })}
                            disabled={saving || !desktopSettings}
                            onChange={(pinned) => void onChange(extensionId, family, { pinned })}
                          />
                        </div>
                      )}
                    </div>
                  );
                },
              )}
            </section>
          ))
        )}
      </div>
      <footer className="shrink-0 border-t border-border p-3">
        {error && (
          <p role="alert" className="mb-2 break-words text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              onClose(false);
              useAppStore.getState().openSettingsSection("extensionUi");
            }}
          >
            {t("extensionUiQuickFullSettings")}
            <ArrowUpRight size={13} />
          </button>
        </div>
      </footer>
      {(Object.entries(RESIZE_EDGES) as [ResizeEdge, string][]).map(([edge, className]) => (
        <div
          key={edge}
          data-extension-ui-quick-resize={edge}
          aria-hidden="true"
          className={"absolute z-10 touch-none " + className}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            resizeStart.current = {
              pointerId: event.pointerId,
              edge,
              x: event.clientX,
              y: event.clientY,
              rect,
              rightOffset: size.rightOffset ?? 0,
              topOffset: size.topOffset ?? 0,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start || start.pointerId !== event.pointerId) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            const { rect } = start;
            const minWidth = Math.min(280, rect.width);
            const minHeight = Math.min(240, rect.height);
            const left = start.edge.includes("w")
              ? Math.max(12, Math.min(rect.right - minWidth, rect.left + dx))
              : rect.left;
            const right = start.edge.includes("e")
              ? Math.min(window.innerWidth - 12, Math.max(rect.left + minWidth, rect.right + dx))
              : rect.right;
            const top = start.edge.includes("n")
              ? Math.max(12, Math.min(rect.bottom - minHeight, rect.top + dy))
              : rect.top;
            const bottom = start.edge.includes("s")
              ? Math.min(window.innerHeight - 12, Math.max(rect.top + minHeight, rect.bottom + dy))
              : rect.bottom;
            resize({
              width: right - left,
              height: bottom - top,
              rightOffset: start.rightOffset + right - rect.right,
              topOffset: start.topOffset + top - rect.top,
            });
          }}
          onPointerUp={(event) => {
            if (resizeStart.current?.pointerId !== event.pointerId) return;
            resizeStart.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
          onLostPointerCapture={() => {
            resizeStart.current = null;
          }}
          onDoubleClick={() => onResize(DEFAULT_PANEL_SIZE)}
        />
      ))}
    </div>,
    document.body,
  );
}

export function ExtensionUiQuickSettings() {
  const t = useT();
  const page = useAppStore((state) => state.page);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [size, setSize] = useState(DEFAULT_PANEL_SIZE);

  useEffect(() => {
    if (page !== "chat") setOpen(false);
  }, [page]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  async function updateHome(extensionId: string, family: QuickFamily, change: HomeChange) {
    if (pending.current) return;
    const desktop = useAppStore.getState().desktopSettings;
    if (!desktop) return;
    const settings = canonicalExtensionUiSettings(desktop);
    if (!settings.observedCapabilities[extensionId]?.families.includes(family)) return;
    const current = settings.presentations[extensionId]?.[family]?.home;
    let home: PresentationHome;
    if ("choice" in change) {
      if (!isLegalPresentationChoice(family, change.choice)) return;
      home = presentationHomeFromChoice(family, change.choice, settings, current);
    } else {
      if (current?.kind !== "float") return;
      home = { ...current, pinned: change.pinned };
    }
    if (JSON.stringify(home) === JSON.stringify(current)) return;
    if (
      home.kind === "float" &&
      current?.kind !== "float" &&
      !canCreateLiveExtensionFloat(extensionId + ":" + family)
    ) {
      setError(t("extensionUiQuickFloatLimit", { count: MAX_EXTENSION_UI_FLOATS }));
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await commitExtensionPresentationHome({
        extensionId,
        family,
        home,
        message: t(extensionUiHomeMessageKey(home), {
          name: observedExtensionDisplayName(extensionId),
          family: t(extensionUiFamilyMessageKey(family)),
        }),
      });
    } catch (reason) {
      setError(t("extensionUiQuickSaveFailed"));
      notifyDesktopSettingsSaveFailure(reason);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={t("extensionUiQuickSettings")}
        aria-label={t("extensionUiQuickSettings")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={iconButton + (open ? " bg-surface-overlay text-foreground" : "")}
        onClick={() => {
          setOpen((value) => !value);
          setError("");
        }}
      >
        <SlidersHorizontal size={15} />
      </button>
      {open && page === "chat" && (
        <QuickPanel
          id={id}
          triggerRef={triggerRef}
          saving={saving}
          error={error}
          size={size}
          onResize={setSize}
          onClose={close}
          onChange={updateHome}
        />
      )}
    </>
  );
}
