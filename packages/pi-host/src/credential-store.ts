/**
 * PiDeck-owned persistent CredentialStore for `auth.json`.
 *
 * SDK 0.82.1 removed `AuthStorage` from the coding-agent public surface and
 * `@earendil-works/pi-ai` exports only the `CredentialStore` contract plus an
 * in-memory implementation, so the persistent store is now app-owned.
 *
 * On-disk format is unchanged from the SDK's own store — a flat
 * `{ [providerId]: Credential }` JSON object, two-space indented, mode 0600 —
 * so PiDeck and the Pi CLI keep sharing `~/.pi/agent`.
 *
 * Two deliberate differences from the SDK implementation:
 *
 * 1. Reads come from disk, not from a snapshot captured at construction. The
 *    SDK store only refreshes its in-memory view when the same process writes,
 *    so a credential rotated by the CLI stays invisible to a long-lived Host.
 * 2. Writes go to a temp file, are fsynced, then renamed over the target. The
 *    SDK writes in place, where a crash mid-write truncates `auth.json`.
 *
 * Storage failures reject with `CredentialStoreError`; pi-ai wraps those in a
 * `ModelsError` with code "auth" rather than silently degrading.
 */
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { resolveCredentialConfigValue } from "./credential-config-value.js";
import { logger } from "./logger.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Bounded on purpose. The SDK's own store retries for roughly 45 seconds,
 * which would leave an interactive provider save looking hung; PiDeck would
 * rather surface a typed `lock_timeout` after a few seconds. `stale` still
 * matches the SDK so a crashed CLI holding the lock is reclaimed the same way.
 */
export type CredentialLockOptions = {
  retries: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  staleMs: number;
};

const DEFAULT_LOCK_OPTIONS: CredentialLockOptions = {
  retries: 6,
  minTimeoutMs: 100,
  maxTimeoutMs: 2_000,
  staleMs: 30_000,
};

export type CredentialStoreErrorCode =
  /** `auth.json` is not valid JSON, or not a JSON object. */
  | "malformed"
  /** The advisory lock could not be acquired within the retry budget. */
  | "lock_timeout"
  /** The lock was lost while the read-modify-write was in flight. */
  | "lock_compromised"
  /** Read, write, rename, or permission failure. */
  | "io";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  readonly path: string;

  constructor(
    code: CredentialStoreErrorCode,
    message: string,
    options: { path: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CredentialStoreError";
    this.code = code;
    this.path = options.path;
  }
}

/** Opaque point-in-time copy of the whole credential file. */
export type CredentialSnapshot = {
  readonly path: string;
  /** `null` means the file did not exist when the snapshot was taken. */
  readonly content: string | null;
};

type CredentialRoot = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
  return isRecord(value) && (value.type === "api_key" || value.type === "oauth");
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  /**
   * In-process serialization. proper-lockfile alone would serialize these too,
   * but only by rejecting and retrying on a backoff, so concurrent refreshes in
   * one Host would each sleep before making progress.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lockOptions: CredentialLockOptions;

  constructor(authPath: string, lockOptions?: Partial<CredentialLockOptions>) {
    this.authPath = authPath;
    this.lockOptions = { ...DEFAULT_LOCK_OPTIONS, ...lockOptions };
  }

  static forAgentDir(
    agentDir: string,
    lockOptions?: Partial<CredentialLockOptions>,
  ): FileCredentialStore {
    return new FileCredentialStore(join(agentDir, "auth.json"), lockOptions);
  }

  // --- CredentialStore contract -------------------------------------------

  /**
   * Display and status use. Resolves `!command` / `$ENV` key templates, which
   * is where pi-ai expects that to happen — `resolveProviderAuth()` passes
   * `credential.key` to the provider verbatim.
   *
   * Unlocked on purpose: writes land via atomic rename, so a reader always
   * observes a complete file, and the request auth path must not queue behind
   * an unrelated provider's write.
   */
  async read(providerId: string): Promise<Credential | undefined> {
    const credential = this.selectCredential(await this.readRoot(), providerId);
    if (credential?.type !== "api_key" || credential.key === undefined) return credential;
    return { ...credential, key: resolveCredentialConfigValue(credential.key, credential.env) };
  }

  /** Metadata only. Never resolves values, so no configured command runs here. */
  async list(): Promise<readonly CredentialInfo[]> {
    const root = await this.readRoot();
    const infos: CredentialInfo[] = [];
    for (const [providerId, value] of Object.entries(root)) {
      if (isCredential(value)) infos.push({ providerId, type: value.type });
    }
    return infos;
  }

  /**
   * The only write path. Serialized against every other `modify`/`delete` on
   * this file, in this process and across processes, so an OAuth refresh
   * cannot race a concurrent login.
   *
   * The callback receives the credential exactly as stored — never the
   * resolved form. Handing back a resolved value would let a caller that
   * spreads `current` write a live secret over a `!command` reference.
   *
   * Returning `undefined` leaves the entry unchanged; deletion is `delete()`.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      const root = await this.readRoot();
      const current = this.selectCredential(root, providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      await this.writeRoot({ ...root, [providerId]: next });
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const root = await this.readRoot();
      if (!(providerId in root)) return;
      const next = { ...root };
      delete next[providerId];
      await this.writeRoot(next);
    });
  }

  // --- PiDeck-only transaction helpers ------------------------------------
  // Deliberately outside the CredentialStore contract: provider mutations need
  // to roll credentials back together with models.json, which the SDK-facing
  // read/modify/delete surface cannot express.

  /**
   * The credential exactly as stored, with no template resolution.
   *
   * Use this when moving a credential between provider ids: `read()` would
   * hand back the resolved secret, and re-storing that would replace a
   * `!command` / `$ENV` reference with a literal key on disk.
   */
  async readRaw(providerId: string): Promise<Credential | undefined> {
    return this.selectCredential(await this.readRoot(), providerId);
  }

  async snapshot(): Promise<CredentialSnapshot> {
    return this.withLock(async () => ({
      path: this.authPath,
      content: await this.readFileText(),
    }));
  }

  async restore(snapshot: CredentialSnapshot): Promise<void> {
    if (snapshot.path !== this.authPath) {
      throw new CredentialStoreError("io", "Credential snapshot belongs to a different auth file", {
        path: this.authPath,
      });
    }
    await this.withLock(async () => {
      if (snapshot.content === null) {
        await unlink(this.authPath).catch((error: unknown) => {
          if (errnoCode(error) !== "ENOENT") throw this.ioError("delete", error);
        });
        return;
      }
      await this.writeText(snapshot.content);
    });
  }

  // --- internals -----------------------------------------------------------

  private selectCredential(root: CredentialRoot, providerId: string): Credential | undefined {
    const value = root[providerId];
    return isCredential(value) ? value : undefined;
  }

  private async readFileText(): Promise<string | null> {
    try {
      return await readFile(this.authPath, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw this.ioError("read", error);
    }
  }

  /** Unknown providers and unknown credential fields survive round-trips. */
  private async readRoot(): Promise<CredentialRoot> {
    const raw = await this.readFileText();
    if (raw === null || raw.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CredentialStoreError("malformed", "auth.json is not valid JSON", {
        path: this.authPath,
        cause: error,
      });
    }
    if (!isRecord(parsed)) {
      throw new CredentialStoreError("malformed", "auth.json is not a JSON object", {
        path: this.authPath,
      });
    }
    return parsed;
  }

  private async writeRoot(root: CredentialRoot): Promise<void> {
    await this.writeText(JSON.stringify(root, null, 2));
  }

  /** Temp file, fsync, atomic rename. The original survives any failure. */
  private async writeText(content: string): Promise<void> {
    await this.ensureParentDir();
    const tempPath = join(dirname(this.authPath), `.auth-${randomUUID()}.tmp`);
    try {
      const handle = await open(tempPath, "wx", FILE_MODE);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw this.ioError("write", error);
    }
    try {
      // `open` honours the mode only when it creates the file; enforce it for
      // umask-restricted and pre-existing cases alike.
      await chmod(tempPath, FILE_MODE);
      // Windows readers/indexers can briefly hold the destination without
      // delete sharing. Retry the atomic replacement while retaining the lock
      // and the same fsynced temp file; never unlink the original credential file.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tempPath, this.authPath);
          break;
        } catch (error) {
          if (
            process.platform !== "win32" ||
            !["EPERM", "EACCES", "EBUSY"].includes(errnoCode(error) ?? "") ||
            attempt >= 6
          )
            throw error;
          await delay(Math.min(20 * 2 ** attempt, 200));
        }
      }
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw this.ioError("rename", error);
    }
    await this.syncParentDir();
  }

  private async ensureParentDir(): Promise<void> {
    try {
      await mkdir(dirname(this.authPath), { recursive: true, mode: DIR_MODE });
    } catch (error) {
      throw this.ioError("create directory for", error);
    }
  }

  /** Best-effort: makes the rename durable where the platform supports it. */
  private async syncParentDir(): Promise<void> {
    let handle;
    try {
      handle = await open(dirname(this.authPath), "r");
      await handle.sync();
    } catch {
      // Windows cannot fsync a directory handle; the rename is still atomic.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * proper-lockfile requires an existing target, and it is the same lock file
   * the SDK's own store uses, so PiDeck and the Pi CLI exclude each other.
   */
  private ensureFileExists(): void {
    if (existsSync(this.authPath)) return;
    mkdirSync(dirname(this.authPath), { recursive: true, mode: DIR_MODE });
    const fd = openSync(this.authPath, "wx", FILE_MODE);
    closeSync(fd);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.withFileLock(fn));
    // Keep the chain alive after a rejection so one failure cannot wedge the store.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.ensureFileExists();
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw this.ioError("create", error);
    }

    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.authPath, {
        realpath: false,
        stale: this.lockOptions.staleMs,
        retries: {
          retries: this.lockOptions.retries,
          factor: 2,
          minTimeout: this.lockOptions.minTimeoutMs,
          maxTimeout: this.lockOptions.maxTimeoutMs,
          randomize: true,
        },
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      throw new CredentialStoreError("lock_timeout", "Timed out locking auth.json", {
        path: this.authPath,
        cause: error,
      });
    }

    try {
      const result = await fn();
      if (compromised) throw this.compromisedError(compromised);
      return result;
    } finally {
      try {
        await release();
      } catch (error) {
        // Releasing a compromised lock throws; the caller already sees that.
        logger.warn("Failed to release credential lock", { code: errnoCode(error) });
      }
    }
  }

  private compromisedError(cause: Error): CredentialStoreError {
    return new CredentialStoreError(
      "lock_compromised",
      "Lost the auth.json lock during a credential write",
      { path: this.authPath, cause },
    );
  }

  /** Carries only the errno — never the file body or a credential. */
  private ioError(action: string, cause: unknown): CredentialStoreError {
    return new CredentialStoreError("io", `Failed to ${action} auth.json`, {
      path: this.authPath,
      cause,
    });
  }
}
