import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
  stat,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { MAX_PREVIEW_TEXT_BYTES, MAX_PREVIEW_MEDIA_BYTES } from "@pideck/protocol";
import {
  readWorkspaceFilePreview,
  writeWorkspaceTextFile,
  FileConflictError,
  FileWorkspaceChangedError,
} from "./workspace-file-content.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pideck-file-content-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function textFile(name = "code.ts", text = "export const name = '中文';\n") {
  await writeFile(join(root, name), text);
  const file = await readWorkspaceFilePreview(root, name);
  if (file.kind !== "text") throw new Error("Expected text");
  return file;
}

describe("workspace file previews", () => {
  it("reads UTF-8, empty files, BOM and mixed line endings", async () => {
    expect(await textFile("empty", "")).toMatchObject({ text: "", sizeBytes: 0 });
    expect(await textFile("mixed", "\uFEFFa\r\nb\r\nc\n")).toMatchObject({
      bom: true,
      lineEnding: "crlf",
      mixedLineEndings: true,
      text: "a\nb\nc\n",
    });
  });
  it("sniffs media without trusting extensions", async () => {
    const fixtures = [
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([255, 216, 255]),
      Buffer.from("GIF89a"),
      Buffer.from("RIFF1234WEBP"),
      Buffer.from("%PDF-1.7\n"),
    ];
    for (const bytes of fixtures) {
      await writeFile(join(root, "asset"), bytes);
      expect(await readWorkspaceFilePreview(root, "asset")).toMatchObject({
        kind: bytes.toString().startsWith("%PDF") ? "pdf" : "image",
        data: bytes.toString("base64"),
      });
    }
  });
  it("bounds reads and rejects invalid UTF-8 and binary content", async () => {
    for (const bytes of [Buffer.from([255]), Buffer.from("a\0b")]) {
      await writeFile(join(root, "binary"), bytes);
      expect(await readWorkspaceFilePreview(root, "binary")).toMatchObject({
        kind: "unsupported",
        reason: "binary",
      });
    }
    await writeFile(join(root, "large"), Buffer.alloc(MAX_PREVIEW_TEXT_BYTES + 1, 65));
    expect(await readWorkspaceFilePreview(root, "large")).toMatchObject({ reason: "tooLarge" });
    await writeFile(join(root, "huge.pdf"), Buffer.alloc(MAX_PREVIEW_MEDIA_BYTES + 1));
    expect(await readWorkspaceFilePreview(root, "huge.pdf")).toMatchObject({ reason: "tooLarge" });
  });
  it("rejects escapes, directories, missing files and symlink traversal", async () => {
    await mkdir(join(root, "dir"));
    await textFile();
    for (const path of [
      "",
      "../outside",
      "/etc/passwd",
      "C:\\outside",
      "missing",
      "dir",
      "nul\0file",
    ])
      await expect(readWorkspaceFilePreview(root, path)).rejects.toThrow();
    await symlink(join(root, "code.ts"), join(root, "link"));
    await symlink(root, join(root, "linked-dir"), "dir");
    await expect(readWorkspaceFilePreview(root, "link")).rejects.toThrow(/Symbolic/);
    await expect(readWorkspaceFilePreview(root, "linked-dir/code.ts")).rejects.toThrow(/Symbolic/);
  });
});

describe("workspace text saves", () => {
  it("preserves BOM, CRLF, permissions and returns the saved version", async () => {
    const file = await textFile("script", "\uFEFFa\r\nb\r\n");
    await chmod(join(root, "script"), 0o755);
    const saved = await writeWorkspaceTextFile(root, "script", "中文\nb\n", file.version);
    expect(await readFile(join(root, "script"), "utf8")).toBe("\uFEFF中文\r\nb\r\n");
    expect(saved.version).not.toBe(file.version);
    expect(saved).toEqual(await readWorkspaceFilePreview(root, "script"));
    if (process.platform !== "win32")
      expect((await stat(join(root, "script"))).mode & 0o777).toBe(0o755);
    expect(await readdir(root)).toEqual(["script"]);
  });
  it("detects same-size external edits even when timestamps are not used", async () => {
    const file = await textFile("file", "aaa");
    await writeFile(join(root, "file"), "bbb");
    await expect(writeWorkspaceTextFile(root, "file", "mine", file.version)).rejects.toBeInstanceOf(
      FileConflictError,
    );
    expect(await readFile(join(root, "file"), "utf8")).toBe("bbb");
  });
  it("serializes concurrent writes against the original version", async () => {
    const file = await textFile();
    const results = await Promise.allSettled([
      writeWorkspaceTextFile(root, file.path, "one", file.version),
      writeWorkspaceTextFile(root, file.path, "two", file.version),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(join(root, file.path), "utf8")).toBe("one");
  });
  it("never creates deleted files and rejects oversized saves", async () => {
    const file = await textFile();
    await expect(
      writeWorkspaceTextFile(root, file.path, "中".repeat(MAX_PREVIEW_TEXT_BYTES), file.version),
    ).rejects.toThrow(/limit/);
    await rm(join(root, file.path));
    await expect(writeWorkspaceTextFile(root, file.path, "x", file.version)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it("rechecks workspace identity before replacing and cleans temporary files", async () => {
    const file = await textFile();
    let checks = 0;
    await expect(
      writeWorkspaceTextFile(root, file.path, "changed", file.version, () => ++checks < 2),
    ).rejects.toBeInstanceOf(FileWorkspaceChangedError);
    expect(await readFile(join(root, file.path), "utf8")).toBe(file.text);
    expect(await readdir(root)).toEqual([file.path]);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports read permission errors",
    async () => {
      await textFile();
      await chmod(join(root, "code.ts"), 0o000);
      await expect(readWorkspaceFilePreview(root, "code.ts")).rejects.toThrow();
      await chmod(join(root, "code.ts"), 0o600);
    },
  );
});
