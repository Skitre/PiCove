import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useBrowserOcclusion } from "../../lib/browser-occlusion";
import { useT } from "../../lib/i18n/use-t";
import {
  minimapLineWidth,
  transcriptTurnPreview,
  type TranscriptTurn,
} from "./transcript-minimap-model";

const STEP = 12;

export function TranscriptMinimap({
  turns,
  scrollRef,
  contentRef,
  rowElements,
  hidden,
  working,
  pendingKey,
  onNavigate,
}: {
  turns: TranscriptTurn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  rowElements: RefObject<Map<string, HTMLDivElement>>;
  hidden: number;
  working: boolean;
  pendingKey: string | null;
  onNavigate: (key: string) => void;
}) {
  const t = useT();
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interacting = useRef(false);
  const focused = useRef(false);
  const hovered = useRef<number | null>(null);
  const [active, setActive] = useState(turns.length - 1);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewPosition, setPreviewPosition] = useState({ left: 0, top: 0, width: 320 });
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => railRef.current,
    estimateSize: () => STEP,
    overscan: 4,
    initialRect: { width: 36, height: 320 },
  });
  useBrowserOcclusion("transcript-minimap:" + id, previewIndex !== null);
  const previewTurn = previewIndex === null ? undefined : turns[previewIndex];
  const preview = useMemo(
    () =>
      previewTurn
        ? transcriptTurnPreview(previewTurn, working && previewIndex === turns.length - 1, t)
        : null,
    [previewTurn, previewIndex, turns.length, working, t],
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let frame = 0;
    let dirty = true;
    let positions: { index: number; top: number }[] = [];
    const update = () => {
      frame = 0;
      if (dirty) {
        const top = scroll.getBoundingClientRect().top;
        positions = turns.flatMap((turn, index) => {
          const element = rowElements.current.get(turn.key);
          return element
            ? [{ index, top: element.getBoundingClientRect().top - top + scroll.scrollTop }]
            : [];
        });
        dirty = false;
      }
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (positions[mid].top <= scroll.scrollTop + 24) low = mid + 1;
        else high = mid;
      }
      const next = positions[Math.max(0, low - 1)]?.index;
      if (next !== undefined) setActive(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(() => {
      dirty = true;
      schedule();
    });
    resize.observe(content);
    resize.observe(scroll);
    scroll.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [turns, hidden, scrollRef, contentRef, rowElements]);

  useEffect(() => {
    if (interacting.current) return;
    const rail = railRef.current;
    if (!rail) return;
    const top = active * STEP;
    if (top < rail.scrollTop || top + STEP > rail.scrollTop + rail.clientHeight) {
      virtualizer.scrollToIndex(active, { align: "center" });
    }
  }, [active, virtualizer]);

  function clearTimers() {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  }
  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (previewIndex === null) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      clearTimers();
      setHighlight(null);
      setPreviewIndex(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [previewIndex]);

  function close() {
    clearTimers();
    setHighlight(null);
    setPreviewIndex(null);
  }
  function enter(index: number, immediate = false) {
    clearTimers();
    interacting.current = true;
    setHighlight(index);
    if (immediate || previewIndex !== null) setPreviewIndex(index);
    else
      openTimer.current = setTimeout(() => {
        setPreviewIndex(index);
        openTimer.current = null;
      }, 120);
  }
  function leave() {
    clearTimers();
    if (focused.current) return;
    closeTimer.current = setTimeout(() => {
      interacting.current = false;
      setHighlight(null);
      setPreviewIndex(null);
      closeTimer.current = null;
    }, 150);
  }

  const keepPreview = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    interacting.current = true;
  }, []);

  useLayoutEffect(() => {
    if (previewIndex === null) return;
    let frame = 0;
    const position = () => {
      const rail = railRef.current;
      const panel = previewRef.current;
      if (rail && panel) {
        const rect = rail.getBoundingClientRect();
        const width = Math.min(320, Math.max(0, window.innerWidth - rect.right - 20));
        const center = rect.top + previewIndex * STEP + STEP / 2 - rail.scrollTop;
        const top = Math.max(
          12,
          Math.min(center - panel.offsetHeight / 2, window.innerHeight - panel.offsetHeight - 12),
        );
        const next = { left: rect.right + 8, top, width };
        setPreviewPosition((previous) =>
          previous.left === next.left && previous.top === next.top && previous.width === next.width
            ? previous
            : next,
        );
      }
      frame = requestAnimationFrame(position);
    };
    position();
    return () => cancelAnimationFrame(frame);
  }, [previewIndex]);

  return (
    <>
      <div
        ref={railRef}
        role="listbox"
        aria-label={t("minimapLabel")}
        aria-activedescendant={highlight === null ? undefined : id + "-" + highlight}
        aria-describedby={preview ? id + "-preview" : undefined}
        tabIndex={0}
        data-transcript-minimap
        className="transcript-minimap-rail absolute left-2 top-1/2 z-10 w-9 -translate-y-1/2 overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-focus"
        style={{ height: Math.min(320, turns.length * STEP), maxHeight: "calc(100% - 24px)" }}
        onPointerEnter={() => {
          interacting.current = true;
        }}
        onPointerMove={(event) => {
          const rail = event.currentTarget;
          const index = Math.max(
            0,
            Math.min(
              turns.length - 1,
              Math.floor(
                (event.clientY - rail.getBoundingClientRect().top + rail.scrollTop) / STEP,
              ),
            ),
          );
          if (hovered.current !== index) {
            hovered.current = index;
            enter(index);
          }
        }}
        onPointerLeave={() => {
          hovered.current = null;
          leave();
        }}
        onScroll={() => {
          hovered.current = null;
          if (!focused.current) close();
        }}
        onFocus={() => {
          focused.current = true;
          enter(active, true);
          virtualizer.scrollToIndex(active, { align: "auto" });
        }}
        onBlur={() => {
          focused.current = false;
          leave();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          const current = highlight ?? active;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onNavigate(turns[current].key);
            return;
          }
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? turns.length - 1
                : event.key === "ArrowUp"
                  ? Math.max(0, current - 1)
                  : event.key === "ArrowDown"
                    ? Math.min(turns.length - 1, current + 1)
                    : null;
          if (next === null) return;
          event.preventDefault();
          virtualizer.scrollToIndex(next, { align: "auto" });
          enter(next, true);
        }}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(({ index, start }) => (
            <div
              key={turns[index].key}
              id={id + "-" + index}
              role="option"
              aria-selected={index === active}
              aria-label={t("minimapTurn", { count: index + 1 })}
              aria-posinset={index + 1}
              aria-setsize={turns.length}
              data-minimap-turn={index}
              className="absolute left-0 flex h-3 w-full cursor-pointer items-center pl-1"
              style={{ top: start }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onNavigate(turns[index].key)}
            >
              <span
                aria-hidden="true"
                className={`h-0.5 origin-left transition-transform duration-[120ms] ease-out motion-reduce:transition-none ${index === highlight || index === active ? "bg-foreground" : "bg-muted/40"}`}
                style={{
                  width: 26,
                  transform: `scaleX(${minimapLineWidth(highlight === null ? null : index - highlight) / 26})`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      {preview &&
        createPortal(
          <div
            ref={previewRef}
            id={id + "-preview"}
            role="tooltip"
            data-minimap-preview
            className="theme-floating-surface fixed z-[45] max-h-[calc(100vh-24px)] overflow-hidden rounded-lg border border-border bg-surface-raised p-3 text-foreground shadow-lg"
            style={previewPosition}
            onPointerEnter={keepPreview}
            onPointerLeave={leave}
          >
            <p className="truncate text-sm font-semibold">{preview.title}</p>
            <p className="mt-1.5 line-clamp-5 whitespace-pre-wrap break-words text-sm leading-5 text-muted">
              {preview.text}
            </p>
            {preview.status && preview.status !== preview.text && (
              <p className="mt-2 text-xs text-muted">{preview.status}</p>
            )}
          </div>,
          document.body,
        )}
      {pendingKey && (
        <div
          role="status"
          className="absolute left-12 top-3 z-10 rounded border border-border bg-surface-raised px-2 py-1 text-xs text-muted"
        >
          {t("minimapLocating")}
        </div>
      )}
    </>
  );
}
