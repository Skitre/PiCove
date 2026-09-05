export const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;
export const MAX_PREVIEW_MEDIA_BYTES = 8 * 1024 * 1024;

export type WorkspaceTextFile = {
  kind: "text";
  path: string;
  sizeBytes: number;
  text: string;
  version: string;
  bom: boolean;
  lineEnding: "lf" | "crlf";
  mixedLineEndings: boolean;
};

export type WorkspaceFilePreview =
  | WorkspaceTextFile
  | {
      kind: "image" | "pdf";
      path: string;
      sizeBytes: number;
      mediaType: string;
      data: string;
    }
  | {
      kind: "unsupported";
      path: string;
      sizeBytes: number;
      reason: "tooLarge" | "binary";
    };

export function isWorkspaceFilePreview(value: unknown): value is WorkspaceFilePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || !Number.isSafeInteger(v.sizeBytes) || Number(v.sizeBytes) < 0)
    return false;
  const keys = (names: string[]) =>
    Object.keys(v).length === names.length && names.every((name) => name in v);
  if (v.kind === "text")
    return (
      keys([
        "kind",
        "path",
        "sizeBytes",
        "text",
        "version",
        "bom",
        "lineEnding",
        "mixedLineEndings",
      ]) &&
      typeof v.text === "string" &&
      v.text.length <= MAX_PREVIEW_TEXT_BYTES &&
      typeof v.version === "string" &&
      /^[a-f0-9]{64}$/.test(v.version) &&
      typeof v.bom === "boolean" &&
      typeof v.mixedLineEndings === "boolean" &&
      (v.lineEnding === "lf" || v.lineEnding === "crlf") &&
      Number(v.sizeBytes) <= MAX_PREVIEW_TEXT_BYTES
    );
  if (v.kind === "image" || v.kind === "pdf")
    return (
      keys(["kind", "path", "sizeBytes", "mediaType", "data"]) &&
      typeof v.data === "string" &&
      v.data.length <= Math.ceil(MAX_PREVIEW_MEDIA_BYTES / 3) * 4 &&
      v.data.length % 4 === 0 &&
      !/[^A-Za-z0-9+/=]/.test(v.data) &&
      Number(v.sizeBytes) <= MAX_PREVIEW_MEDIA_BYTES &&
      (v.kind === "pdf"
        ? v.mediaType === "application/pdf"
        : ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(v.mediaType)))
    );
  return (
    v.kind === "unsupported" &&
    keys(["kind", "path", "sizeBytes", "reason"]) &&
    (v.reason === "tooLarge" || v.reason === "binary")
  );
}
