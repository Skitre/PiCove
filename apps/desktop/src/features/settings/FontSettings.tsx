import { useEffect, useId, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { DesktopFontCatalog, DesktopFontFamily, DesktopFontReference } from "@pideck/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronsUpDown, RefreshCw, Trash2, Type, Upload } from "lucide-react";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  removeImportedFont,
} from "../../lib/desktop-settings";
import {
  FONT_CHANGED_EVENT,
  FONT_FIELDS,
  familyReference,
  fontLoadError,
  fontReferenceKey,
  importFonts,
  listFontCatalog,
  prepareFont,
} from "../../lib/fonts";

type FontField = (typeof FONT_FIELDS)[number];
const defaultFont: DesktopFontReference = { source: "default" };
const labels = { uiFont: "fontUi", textFont: "fontText", codeFont: "fontCode" } as const;
const descriptions = {
  uiFont: "fontUiDesc",
  textFont: "fontTextDesc",
  codeFont: "fontCodeDesc",
} as const;

export function dropHitsFontArea(
  position: { x: number; y: number },
  scale: number,
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): boolean {
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function findFamily(catalog: DesktopFontCatalog, reference: DesktopFontReference | undefined) {
  return catalog.families.find(
    (family) => fontReferenceKey(familyReference(family)) === fontReferenceKey(reference),
  );
}

function fontName(
  catalog: DesktopFontCatalog,
  reference: DesktopFontReference | undefined,
  t: Translate,
) {
  if (!reference || reference.source === "default") return t("fontDefault");
  return (
    findFamily(catalog, reference)?.family ??
    (reference.source === "system" ? reference.family : t("fontMissing"))
  );
}

function readableError(error: unknown, t: Translate): string {
  const message = String(error);
  if (/desktop-only/i.test(message)) return t("fontDesktopOnly");
  if (/exceed|limit|1,000|128 MiB|512 MiB/i.test(message)) return t("fontErrorLimit");
  if (/already exists/i.test(message)) return t("fontErrorConflict");
  if (/unsafe|encrypt|regular file/i.test(message)) return t("fontErrorUnsafe");
  if (/unsupported|supported files/i.test(message)) return t("fontErrorUnsupported");
  if (/invalid|no readable|no valid|no supported/i.test(message)) return t("fontErrorInvalid");
  return t("fontError") + ": " + message;
}

type FontRow =
  | { kind: "heading"; key: string; label: string }
  | {
      kind: "option";
      key: string;
      label: string;
      reference: DesktopFontReference;
      monospace: boolean;
    };

function FontPicker({
  field,
  value,
  catalog,
  onClose,
}: {
  field: FontField;
  value: DesktopFontReference | undefined;
  catalog: DesktopFontCatalog;
  onClose: () => void;
}) {
  const t = useT();
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [monoOnly, setMonoOnly] = useState(false);
  const [candidate, setCandidate] = useState(value ?? defaultFont);
  const [preview, setPreview] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const selectedKey = fontReferenceKey(candidate);

  const groups = [
    { source: "default", label: t("fontDefaultGroup") },
    { source: "system", label: t("fontSystemGroup") },
    { source: "imported", label: t("fontImportedGroup") },
  ] as const;
  const rows: FontRow[] = [];
  for (const group of groups) {
    const options: Extract<FontRow, { kind: "option" }>[] =
      group.source === "default"
        ? [
            {
              kind: "option",
              key: "default",
              label: t("fontDefault"),
              reference: defaultFont,
              monospace: field === "codeFont",
            },
          ]
        : catalog.families
            .filter(
              (family) =>
                family.source === group.source &&
                family.family.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
                (!monoOnly || family.monospace),
            )
            .map((family) => ({
              kind: "option",
              key: fontReferenceKey(familyReference(family)),
              label: family.family,
              reference: familyReference(family),
              monospace: family.monospace,
            }));
    if (options.length)
      rows.push({ kind: "heading", key: group.source, label: group.label }, ...options);
  }
  const options = rows.filter((row) => row.kind === "option");
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 6,
    initialRect: { width: 400, height: 252 },
    getItemKey: (index) => rows[index].kind + ":" + rows[index].key,
  });
  const candidateIndex = rows.findIndex((row) => row.kind === "option" && row.key === selectedKey);
  const candidateFamily = findFamily(catalog, candidate);

  useEffect(() => {
    if (candidateIndex >= 0) virtualizer.scrollToIndex(candidateIndex, { align: "auto" });
  }, [candidateIndex, virtualizer]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSaveError("");
    setPreview(undefined);
    void prepareFont(candidate)
      .then(
        (css) => {
          if (!cancelled) setPreview(css);
        },
        (reason) => {
          if (!cancelled) setError(readableError(reason, t));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate, previewAttempt, t]);

  async function commit() {
    if (loading || saving || error) return;
    setSaving(true);
    setSaveError("");
    try {
      await persistDesktopSettings({ [field]: candidate });
      onClose();
    } catch (reason) {
      setSaveError(readableError(reason, t));
      notifyDesktopSettingsSaveFailure(reason);
    } finally {
      setSaving(false);
    }
  }

  function move(delta: number) {
    const current = options.findIndex((option) => option.key === selectedKey);
    const next = options[Math.max(0, Math.min(options.length - 1, current + delta))];
    if (!next) return;
    setCandidate(next.reference);
    const index = rows.indexOf(next);
    virtualizer.scrollToIndex(index, { align: "auto" });
  }

  return (
    <Dialog
      title={t(labels[field])}
      icon={Type}
      confirmLabel={t(saving ? "fontSaving" : "fontUse")}
      confirmDisabled={loading || saving || !!error}
      onCancel={() => {
        if (!saving) onClose();
      }}
      onConfirm={() => void commit()}
    >
      <label className="block text-xs text-muted" htmlFor={listId + "-search"}>
        {t("fontSearch")}
      </label>
      <input
        ref={searchRef}
        id={listId + "-search"}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={candidateIndex >= 0 ? listId + "-" + candidateIndex : undefined}
        value={query}
        disabled={saving}
        className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-focus"
        onChange={(event) => {
          setQuery(event.target.value);
          scrollRef.current?.scrollTo?.(0, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
        }}
      />
      {field === "codeFont" && (
        <label className="mt-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={monoOnly}
            disabled={saving}
            onChange={(event) => setMonoOnly(event.target.checked)}
          />
          {t("fontMonoOnly")}
        </label>
      )}
      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label={t("fontAvailable")}
        className="mt-3 h-[252px] overflow-auto rounded-md border border-border bg-surface"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const style = {
              position: "absolute" as const,
              left: 0,
              top: 0,
              width: "100%",
              height: item.size,
              transform: "translateY(" + item.start + "px)",
            };
            if (row.kind === "heading")
              return (
                <div
                  key={item.key}
                  role="presentation"
                  style={style}
                  className="flex items-end px-3 pb-1 text-[11px] text-muted"
                >
                  {row.label}
                </div>
              );
            return (
              <button
                key={item.key}
                id={listId + "-" + item.index}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={row.key === selectedKey}
                disabled={saving}
                style={style}
                className={
                  "flex items-center gap-2 px-3 text-left text-sm hover:bg-surface-overlay " +
                  (row.key === selectedKey
                    ? "bg-selection text-selection-foreground"
                    : "text-foreground")
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setCandidate(row.reference);
                  searchRef.current?.focus();
                }}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.monospace && (
                  <span className="shrink-0 text-[10px] text-muted">{t("fontMonospace")}</span>
                )}
                {row.key === selectedKey && <Check size={14} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
      {query && options.length === 1 && <p className="mt-2 text-xs">{t("fontNoResults")}</p>}
      <div className="mt-4 rounded-lg border border-border bg-surface p-3" aria-busy={loading}>
        <p className="mb-2 text-[11px] text-muted">
          {t("appearancePreview")} · {fontName(catalog, candidate, t)}
        </p>
        <div
          className="space-y-2 text-foreground"
          style={{
            fontFamily:
              (preview ? preview + ", " : "") +
              (field === "codeFont" ? "var(--font-default-mono)" : "var(--font-default-sans)"),
          }}
        >
          <p className="text-base">清晰易读的文字 · Readable text</p>
          <p className="text-sm font-semibold">中文 Aa Bb 0123456789</p>
          <pre className="overflow-x-auto text-xs" style={{ fontFamily: "inherit" }}>
            {'const ready = true;\n  return "你好, PiDeck";'}
          </pre>
        </div>
      </div>
      {field === "codeFont" && candidateFamily && !candidateFamily.monospace && (
        <p className="mt-2 text-xs text-warning">{t("fontNonMonoWarning")}</p>
      )}
      {loading && (
        <p role="status" className="mt-2 text-xs">
          {t("fontLoadingPreview")}
        </p>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">
            {error}
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
          >
            <RefreshCw size={12} />
            {t("fontRetry")}
          </button>
        </div>
      )}
      {saveError && (
        <p role="alert" className="mt-2 break-words text-xs text-danger">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}

export function FontSettings() {
  const t = useT();
  const settings = useAppStore((state) => state.desktopSettings);
  const [catalog, setCatalog] = useState<DesktopFontCatalog>({ families: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<FontField | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DesktopFontFamily | null>(null);
  const [report, setReport] = useState<Awaited<ReturnType<typeof importFonts>> | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, refreshStatus] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const operations = useRef(false);
  const desktop = isTauri();
  const importRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  const modalOpen = useRef(false);
  modalOpen.current = !!picker || !!removeTarget;

  async function refresh(refreshSystem = false) {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const next = await listFontCatalog(true, refreshSystem);
      if (mounted.current && id === request.current) {
        setCatalog(next);
        setError(desktop && next.systemError ? readableError(next.systemError, t) : "");
      }
    } catch (reason) {
      if (mounted.current && id === request.current) setError(readableError(reason, t));
    } finally {
      if (mounted.current && id === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const listener = () => refreshStatus((value) => value + 1);
    window.addEventListener(FONT_CHANGED_EVENT, listener);
    return () => {
      mounted.current = false;
      window.removeEventListener(FONT_CHANGED_EVENT, listener);
    };
    // The catalog is locale-independent; explicit refresh handles OS font changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runImport(paths: string[]) {
    if (operations.current || !paths.length) return;
    operations.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await importFonts(paths);
      if (mounted.current) {
        setReport(next);
        await refresh();
      }
    } catch (reason) {
      if (mounted.current) setError(readableError(reason, t));
    } finally {
      operations.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  importRef.current = runImport;

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        if (cancelled) return;
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "leave") {
            setDragging(false);
            return;
          }
          const rect = area.current?.getBoundingClientRect();
          const hit =
            !modalOpen.current &&
            !operations.current &&
            rect &&
            dropHitsFontArea(payload.position, window.devicePixelRatio || 1, rect);
          if (payload.type === "drop") {
            setDragging(false);
            if (hit) void importRef.current(payload.paths);
          } else setDragging(!!hit);
        });
        if (cancelled) unlisten();
      })
      .catch((reason) => {
        if (!cancelled) setError(readableError(reason, t));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktop, t]);

  async function chooseFiles() {
    if (operations.current) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({
        multiple: true,
        directory: false,
        title: t("fontImport"),
        filters: [{ name: t("fontFiles"), extensions: ["ttf", "otf", "ttc", "zip"] }],
      });
      if (paths) await runImport(Array.isArray(paths) ? paths : [paths]);
    } catch (reason) {
      setError(readableError(reason, t));
    }
  }

  async function reset(field: FontField) {
    setBusy(true);
    try {
      await persistDesktopSettings({ [field]: defaultFont });
    } catch (reason) {
      notifyDesktopSettingsSaveFailure(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function remove() {
    if (!removeTarget || operations.current) return;
    operations.current = true;
    setBusy(true);
    try {
      await removeImportedFont(removeTarget.id);
      setRemoveTarget(null);
      await refresh();
    } catch (reason) {
      setRemoveTarget(null);
      setError(readableError(reason, t));
    } finally {
      operations.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function closePicker() {
    const previous = picker;
    setPicker(null);
    requestAnimationFrame(() => document.getElementById("font-select-" + previous)?.focus());
  }
  const imported = catalog.families.filter((family) => family.source === "imported");

  return (
    <section aria-labelledby="font-settings-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="font-settings-heading" className="text-sm font-medium text-muted">
          {t("fontHeading")}
        </h2>
        <button
          type="button"
          className={secondaryButton}
          disabled={loading || busy || !desktop}
          onClick={() => void refresh(true)}
        >
          <RefreshCw size={12} />
          {t("fontRefresh")}
        </button>
      </div>
      <div className="interface-density-card flex flex-col gap-4 rounded-lg border border-border p-4">
        {FONT_FIELDS.map((field) => {
          const reference = settings?.[field];
          const unavailable =
            fontReferenceKey(reference) !== "default" &&
            !loading &&
            (!findFamily(catalog, reference) || !!fontLoadError(reference));
          return (
            <div key={field} className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <label htmlFor={"font-select-" + field} className="block text-sm">
                    {t(labels[field])}
                  </label>
                  <p className="text-xs text-muted">{t(descriptions[field])}</p>
                </div>
                <div className="flex items-center gap-2 sm:max-w-[55%]">
                  <button
                    id={"font-select-" + field}
                    type="button"
                    aria-haspopup="dialog"
                    disabled={loading || busy || !desktop}
                    className="interface-density-control flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 text-left text-xs hover:bg-surface-overlay disabled:opacity-50 sm:w-44"
                    onClick={() => setPicker(field)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {fontName(catalog, reference, t)}
                    </span>
                    <ChevronsUpDown size={13} className="shrink-0" />
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || fontReferenceKey(reference) === "default"}
                    aria-label={t("fontResetCategory", { category: t(labels[field]) })}
                    onClick={() => void reset(field)}
                  >
                    {t("fontReset")}
                  </button>
                </div>
              </div>
              {unavailable && (
                <p role="status" className="text-xs text-warning">
                  {t("fontMissingDesc")}
                </p>
              )}
            </div>
          );
        })}
        {loading && (
          <p role="status" className="text-xs text-muted">
            {t("fontLoading")}
          </p>
        )}
        <div
          ref={area}
          className={
            "rounded-lg border border-dashed p-4 transition-colors " +
            (dragging ? "border-focus bg-focus/10" : "border-border bg-surface")
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(dragging ? "fontDropNow" : "fontDrop")}</p>
              <p className="mt-1 text-xs text-muted">{t("fontImportDesc")}</p>
            </div>
            <button
              type="button"
              className={secondaryButton}
              disabled={busy || !desktop}
              onClick={() => void chooseFiles()}
            >
              <Upload size={13} />
              {t(busy ? "fontWorking" : "fontImport")}
            </button>
          </div>
        </div>
        {!desktop && <p className="text-xs text-muted">{t("fontDesktopOnly")}</p>}
        {error && (
          <p role="alert" className="break-words text-xs text-danger">
            {error}
          </p>
        )}
        {report && (
          <div aria-live="polite" className="rounded-md border border-border p-3 text-xs">
            <p className="font-medium">
              {t("fontImportSummary", {
                imported: report.items.filter((item) => item.status === "imported").length,
                skipped: report.items.filter((item) => item.status === "skipped").length,
                failed: report.items.filter((item) => item.status === "failed").length,
              })}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-muted">{t("fontImportDetails")}</summary>
              <ul className="mt-2 max-h-48 space-y-2 overflow-auto">
                {report.items.map((item, index) => (
                  <li key={index} className="break-words">
                    <span className={item.status === "failed" ? "text-danger" : "text-muted"}>
                      {t(
                        item.status === "imported"
                          ? "fontImported"
                          : item.status === "skipped"
                            ? "fontSkipped"
                            : "fontFailed",
                      )}
                    </span>
                    {" · "}
                    {item.name}
                    {" — "}
                    {item.status === "failed" || item.detail === "Unsupported file type"
                      ? readableError(item.detail, t)
                      : item.detail}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {imported.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium text-muted">{t("fontImportedGroup")}</p>
            <ul className="max-h-60 space-y-1 overflow-auto">
              {imported.map((family) => (
                <li key={family.id} className="flex items-center gap-2 rounded-md py-1">
                  <span className="min-w-0 flex-1 truncate text-xs">{family.family}</span>
                  <span className="text-[11px] text-muted">
                    {t("fontFaceCount", { count: family.faces.length })}
                  </span>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    aria-label={t("fontDeleteNamed", { name: family.family })}
                    onClick={() => setRemoveTarget(family)}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {picker && (
        <FontPicker
          field={picker}
          value={settings?.[picker]}
          catalog={catalog}
          onClose={closePicker}
        />
      )}
      {removeTarget && (
        <Dialog
          title={t("fontDeleteNamed", { name: removeTarget.family })}
          tone="danger"
          confirmLabel={t(busy ? "fontWorking" : "fontDelete")}
          confirmDisabled={busy}
          onCancel={() => {
            if (!busy) setRemoveTarget(null);
          }}
          onConfirm={() => void remove()}
        >
          <p>{t("fontDeleteDesc")}</p>
        </Dialog>
      )}
    </section>
  );
}
