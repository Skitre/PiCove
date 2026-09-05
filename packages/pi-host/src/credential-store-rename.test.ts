import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "./credential-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe.runIf(process.platform === "win32")("Windows credential replacement", () => {
  let root: string;
  let path: string;
  let original: string;
  beforeEach(() => {
    vi.mocked(rename).mockClear();
    root = mkdtempSync(join(tmpdir(), "pideck-rename-"));
    path = join(root, "auth.json");
    original = JSON.stringify({ p: { type: "api_key", key: "test-old" } });
    writeFileSync(path, original);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries %s atomically without rerunning the credential update",
    async (code) => {
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("busy"), { code }));
      const modify = vi.fn(async () => ({ type: "api_key" as const, key: "test-new" }));
      await new FileCredentialStore(path).modify("p", modify);
      expect(modify).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(path, "utf8")).p.key).toBe("test-new");
      expect(readdirSync(root)).toEqual(["auth.json"]);
    },
  );

  it("bounds retries and preserves the original if the destination stays busy", async () => {
    for (let i = 0; i < 7; i++)
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }));
    await expect(
      new FileCredentialStore(path).modify("p", async () => ({ type: "api_key", key: "test-new" })),
    ).rejects.toMatchObject({ code: "io" });
    expect(rename).toHaveBeenCalledTimes(7);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(root)).toEqual(["auth.json"]);
  });

  it("does not retry unrelated filesystem failures", async () => {
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    await expect(
      new FileCredentialStore(path).modify("p", async () => ({ type: "api_key", key: "test-new" })),
    ).rejects.toMatchObject({ code: "io" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(root)).toEqual(["auth.json"]);
  });
});
