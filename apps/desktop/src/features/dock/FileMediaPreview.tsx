import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize, ZoomIn, ZoomOut, Scan } from "lucide-react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useT } from "../../lib/i18n/use-t";
import { FileToolButton } from "./FileToolButton";
import "./file-preview.css";

export function previewBytes(data: string): Uint8Array<ArrayBuffer> {
  const raw = atob(data);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function ImageFilePreview({
  data,
  mediaType,
  name,
}: {
  data: string;
  mediaType: string;
  name: string;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [scale, setScale] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([previewBytes(data)], { type: mediaType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data, mediaType]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="file-tools">
        <FileToolButton
          label={t("fileZoomOut")}
          onClick={() => setScale(Math.max(0.1, (scale ?? 1) - 0.25))}
        >
          <ZoomOut size={15} />
        </FileToolButton>
        <span className="w-12 text-center text-xs">
          {scale === null ? t("fileFit") : `${Math.round(scale * 100)}%`}
        </span>
        <FileToolButton
          label={t("fileZoomIn")}
          onClick={() => setScale(Math.min(4, (scale ?? 1) + 0.25))}
        >
          <ZoomIn size={15} />
        </FileToolButton>
        <FileToolButton label={t("fileFit")} onClick={() => setScale(null)}>
          <Maximize size={15} />
        </FileToolButton>
        <FileToolButton label={t("fileOriginalSize")} onClick={() => setScale(1)}>
          <Scan size={15} />
        </FileToolButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <p role="alert">{t("fileMediaFailed")}</p>
        ) : (
          url && (
            <img
              src={url}
              alt={name}
              onError={() => setError(true)}
              className={scale === null ? "mx-auto h-full max-w-full object-contain" : "max-w-none"}
              style={scale === null ? undefined : { zoom: scale }}
            />
          )
        )}
      </div>
    </div>
  );
}

export function PdfFilePreview({ data }: { data: string }) {
  const t = useT();
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState<number | null>(null);
  const [width, setWidth] = useState(400);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    let destroy = () => {};
    void import("pdfjs-dist/legacy/build/pdf.mjs")
      .then(async (pdf) => {
        if (disposed) return;
        pdf.GlobalWorkerOptions.workerSrc = pdfWorker;
        const task = pdf.getDocument({
          data: previewBytes(data),
          cMapUrl: "/pdf-assets/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdf-assets/standard_fonts/",
          wasmUrl: "/pdf-assets/wasm/",
        });
        destroy = () => {
          void task.destroy();
        };
        const loaded = await task.promise;
        if (!disposed) setDocument(loaded);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      destroy();
    };
  }, [data]);
  useEffect(() => {
    if (!document || !canvas.current || !textLayer.current || !sheet.current) return;
    let disposed = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const target = canvas.current;
    const textTarget = textLayer.current;
    const pageTarget = sheet.current;
    setRendering(true);
    setError(null);
    void (async () => {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdfPage = await document.getPage(page);
      if (disposed) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({
        scale: scale ?? Math.max(0.1, (width - 24) / natural.width),
      });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      pageTarget.style.width = `${viewport.width}px`;
      pageTarget.style.height = `${viewport.height}px`;
      textTarget.replaceChildren();
      textTarget.style.setProperty("--scale-factor", String(viewport.scale));
      textTarget.style.setProperty("--total-scale-factor", String(viewport.scale));
      render = pdfPage.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (disposed) return;
      layer = new pdf.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: textTarget,
        viewport,
      });
      await layer.render();
      if (!disposed) setRendering(false);
    })().catch((reason: unknown) => {
      if (!disposed) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setRendering(false);
      }
    });
    return () => {
      disposed = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [document, page, scale, width]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="file-tools flex-wrap">
        <FileToolButton
          label={t("filePreviousPage")}
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={15} />
        </FileToolButton>
        <input
          aria-label={t("filePage")}
          type="number"
          min={1}
          max={document?.numPages ?? 1}
          value={page}
          className="w-12 rounded border border-border bg-surface px-1 text-xs"
          onChange={(e) =>
            setPage(
              Math.min(
                document?.numPages ?? 1,
                Math.max(1, Math.trunc(Number(e.target.value)) || 1),
              ),
            )
          }
        />
        <span className="text-xs">/ {document?.numPages ?? "?"}</span>
        <FileToolButton
          label={t("fileNextPage")}
          disabled={!document || page >= document.numPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={15} />
        </FileToolButton>
        <FileToolButton
          label={t("fileZoomOut")}
          onClick={() => setScale(Math.max(0.25, (scale ?? 1) - 0.25))}
        >
          <ZoomOut size={15} />
        </FileToolButton>
        <FileToolButton
          label={t("fileZoomIn")}
          onClick={() => setScale(Math.min(3, (scale ?? 1) + 0.25))}
        >
          <ZoomIn size={15} />
        </FileToolButton>
        <FileToolButton label={t("fileFit")} onClick={() => setScale(null)}>
          <Maximize size={15} />
        </FileToolButton>
        <span className="text-xs text-muted">
          {scale === null ? t("fileFit") : `${Math.round(scale * 100)}%`}
        </span>
      </div>
      {error && (
        <p role="alert" className="break-words p-3 text-xs text-danger">
          {t("fileMediaFailed")}: {error}
        </p>
      )}
      <div
        ref={scroll}
        className="min-h-0 flex-1 overflow-auto p-3"
        aria-busy={rendering && !error}
      >
        {!document && !error && <p className="text-xs text-muted">{t("fileLoading")}</p>}
        <div
          ref={sheet}
          className="relative mx-auto bg-white"
          style={{ visibility: rendering || error ? "hidden" : "visible" }}
        >
          <canvas ref={canvas} />
          <div ref={textLayer} className="textLayer" />
        </div>
      </div>
    </div>
  );
}
