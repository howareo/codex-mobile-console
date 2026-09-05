import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STORE_VERSION = 1;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_WRITE_DELAY_MS = 1_000;

interface StoredSession {
  digest: string;
  epoch: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredSessionFile {
  version: number;
  sessions: StoredSession[];
}

export interface SessionStoreOptions {
  ttlMs: number;
  pairingSecret: string;
  filePath?: string | null;
  maxSessions?: number;
  writeDelayMs?: number;
  now?: () => number;
  onError?: (event: "sessions.load_failed" | "sessions.write_failed", error: unknown) => void;
}

export interface CreatedSession {
  id: string;
  epoch: string;
  expiresAt: number;
}

export interface SessionValidation {
  epoch: string;
  expiresAt: number;
  renewed: boolean;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly ttlMs: number;
  private readonly pairingSecret: string;
  private readonly filePath: string | null;
  private readonly maxSessions: number;
  private readonly writeDelayMs: number;
  private readonly now: () => number;
  private readonly onError: NonNullable<SessionStoreOptions["onError"]>;
  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  private constructor(options: SessionStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.pairingSecret = options.pairingSecret;
    this.filePath = options.filePath ?? null;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  public static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const store = new SessionStore(options);
    await store.load();
    return store;
  }

  public authenticate(candidate: string, expected: string = this.pairingSecret): boolean {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqualBuffers(left, right);
  }

  public create(): CreatedSession {
    const id = randomBytes(32).toString("base64url");
    const now = this.now();
    const session: StoredSession = {
      digest: this.digest(id),
      epoch: randomBytes(16).toString("base64url"),
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.sessions.set(session.digest, session);
    this.prune(now);
    this.markDirty();
    return { id, epoch: session.epoch, expiresAt: session.expiresAt };
  }

  public use(id: string | undefined, renew = true): SessionValidation | null {
    if (!id) return null;
    const digest = this.digest(id);
    const session = this.sessions.get(digest);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(digest);
      this.markDirty();
      return null;
    }
    let renewed = false;
    if (renew && session.expiresAt - now <= this.ttlMs / 2) {
      session.expiresAt = now + this.ttlMs;
      renewed = true;
      this.markDirty();
    }
    return { epoch: session.epoch, expiresAt: session.expiresAt, renewed };
  }

  public revoke(id: string | undefined): void {
    if (id && this.sessions.delete(this.digest(id))) this.markDirty();
  }

  public async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    while (this.filePath && this.dirty) {
      this.dirty = false;
      const snapshot = this.snapshot();
      this.writePromise = this.writePromise.then(() => this.persist(snapshot)).catch(error => {
        this.onError("sessions.write_failed", error);
      });
      await this.writePromise;
    }
    await this.writePromise;
  }

  private digest(id: string): string {
    return createHmac("sha256", this.pairingSecret).update(Buffer.from(id, "utf8")).digest("hex");
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoredSessionFile>;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.sessions)) throw new Error("unsupported session store schema");
      const now = this.now();
      for (const value of parsed.sessions) {
        if (!validStoredSession(value) || value.expiresAt <= now) continue;
        this.sessions.set(value.digest, { ...value });
      }
      if (this.sessions.size !== parsed.sessions.length || this.sessions.size > this.maxSessions) {
        this.prune(now);
        this.markDirty();
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      this.sessions.clear();
      this.onError("sessions.load_failed", error);
    }
  }

  private prune(now: number): void {
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(digest);
    }
    if (this.sessions.size <= this.maxSessions) return;
    const excess = [...this.sessions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, this.sessions.size - this.maxSessions);
    for (const session of excess) this.sessions.delete(session.digest);
  }

  private markDirty(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.writeDelayMs);
    this.writeTimer.unref?.();
  }

  private snapshot(): StoredSessionFile {
    return {
      version: STORE_VERSION,
      sessions: [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt).map(session => ({ ...session }))
    };
  }

  private async persist(snapshot: StoredSessionFile): Promise<void> {
    if (!this.filePath) return;
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function validStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<StoredSession>;
  return typeof session.digest === "string"
    && /^[a-f0-9]{64}$/.test(session.digest)
    && typeof session.epoch === "string"
    && /^[A-Za-z0-9_-]{20,30}$/.test(session.epoch)
    && typeof session.createdAt === "number"
    && Number.isFinite(session.createdAt)
    && typeof session.expiresAt === "number"
    && Number.isFinite(session.expiresAt);
}

function timingSafeEqualBuffers(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
