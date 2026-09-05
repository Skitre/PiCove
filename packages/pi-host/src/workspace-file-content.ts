import { constants } from "node:fs";
import { access, chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  MAX_PREVIEW_MEDIA_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  type WorkspaceFilePreview,
  type WorkspaceTextFile,
} from "@pideck/protocol";
import { normalizeWorkspaceRelativePath } from "./workspace-files.js";

export class FileConflictError extends Error {}
export class FileWorkspaceChangedError extends Error {}

async function checkedPath(root: string, input: string) {
  const path = normalizeWorkspaceRelativePath(input);
  if (!path) throw new Error("A file path is required");
  let absolute = root;
  for (const part of path.split("/")) {
    absolute = resolve(absolute, part);
    if ((await lstat(absolute)).isSymbolicLink())
      throw new Error("Symbolic links cannot be opened");
  }
  const stats = await lstat(absolute);
  if (!stats.isFile()) throw new Error("Path is not a regular file");
  return { path, absolute, stats };
}

const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function describeText(path: string, bytes: Buffer): WorkspaceTextFile | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) return null;
  const bom = text.startsWith("\uFEFF");
  if (bom) text = text.slice(1);
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  const loneCr = /\r(?!\n)/.test(text);
  return {
    kind: "text",
    path,
    sizeBytes: bytes.length,
    text: text.replace(/\r\n|\r/g, "\n"),
    version: versionOf(bytes),
    bom,
    lineEnding: crlf > lf ? "crlf" : "lf",
    mixedLineEndings: (crlf > 0 && lf > 0) || loneCr,
  };
}

function mediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  return null;
}

async function readBytes(root: string, input: string) {
  const file = await checkedPath(root, input);
  const handle = await open(
    file.absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== file.stats.ino || stats.dev !== file.stats.dev)
      throw new Error("File changed while opening");
    if (stats.size > MAX_PREVIEW_MEDIA_BYTES) return { ...file, bytes: null, size: stats.size };
    // Read at most the limit plus one byte, including files growing during a read.
    const buffer = Buffer.alloc(Math.min(MAX_PREVIEW_MEDIA_BYTES + 1, stats.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || length !== stats.size)
      throw new Error("File changed while reading; retry");
    return { ...file, bytes: buffer.subarray(0, length), size: length };
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceFilePreview(
  root: string,
  input: string,
): Promise<WorkspaceFilePreview> {
  const { path, bytes, size } = await readBytes(root, input);
  const unsupported = (reason: "tooLarge" | "binary"): WorkspaceFilePreview => ({
    kind: "unsupported",
    path,
    sizeBytes: size,
    reason,
  });
  if (!bytes) return unsupported("tooLarge");
  const media = mediaType(bytes);
  if (media)
    return {
      kind: media === "application/pdf" ? "pdf" : "image",
      path,
      sizeBytes: size,
      mediaType: media,
      data: bytes.toString("base64"),
    };
  if (size > MAX_PREVIEW_TEXT_BYTES) return unsupported("tooLarge");
  return describeText(path, bytes) ?? unsupported("binary");
}

const writes = new Map<string, Promise<unknown>>();

export async function writeWorkspaceTextFile(
  root: string,
  input: string,
  text: string,
  expectedVersion: string,
  isCurrent = () => true,
): Promise<WorkspaceTextFile> {
  const key = join(root, normalizeWorkspaceRelativePath(input));
  const previous = writes.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      const assertCurrent = () => {
        if (!isCurrent()) throw new FileWorkspaceChangedError("Workspace changed before save");
      };
      assertCurrent();
      const source = await readBytes(root, input);
      await access(source.absolute, constants.W_OK);
      if ((source.stats.mode & 0o222) === 0) throw new Error("File is read-only");
      if (!source.bytes || source.size > MAX_PREVIEW_TEXT_BYTES)
        throw new Error("Text file exceeds the 1 MiB limit");
      if (mediaType(source.bytes)) throw new Error("Only UTF-8 text files can be saved");
      const original = describeText(source.path, source.bytes);
      if (!original) throw new Error("Only UTF-8 text files can be saved");
      if (original.version !== expectedVersion) throw new FileConflictError("File changed on disk");
      const normalized = text.replace(/\r\n|\r/g, "\n");
      const bytes = Buffer.from(
        (original.bom ? "\uFEFF" : "") +
          (original.lineEnding === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized),
        "utf8",
      );
      if (bytes.length > MAX_PREVIEW_TEXT_BYTES) throw new Error("Text exceeds the 1 MiB limit");
      const result = describeText(source.path, bytes);
      if (!result) throw new Error("Binary text cannot be saved");
      const temporary = join(dirname(source.absolute), `.pideck-save-${randomUUID()}`);
      try {
        const handle = await open(temporary, "wx", source.stats.mode & 0o777);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, source.stats.mode & 0o777);
        const current = await readBytes(root, input);
        if (
          !current.bytes ||
          versionOf(current.bytes) !== expectedVersion ||
          current.stats.ino !== source.stats.ino ||
          current.stats.dev !== source.stats.dev
        )
          throw new FileConflictError("File changed on disk");
        assertCurrent();
        await rename(temporary, source.absolute);
        return result;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
  writes.set(key, task);
  try {
    return await task;
  } finally {
    if (writes.get(key) === task) writes.delete(key);
  }
}
