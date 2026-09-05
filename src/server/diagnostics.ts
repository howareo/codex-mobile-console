import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, basename } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

interface TimedResult {
  at: number;
  durationMs: number;
  ok: boolean;
  timeout?: boolean;
}

export interface StabilityWindow {
  windowMs: number;
  upstream: {
    requests: number;
    failures: number;
    timeouts: number;
    successRate: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
  snapshots: {
    runs: number;
    failures: number;
    successRate: number | null;
    p95Ms: number | null;
  };
  reconnects: number;
}

const SENSITIVE_KEY = /token|secret|cookie|authorization|password|body|text|content|command|diff|raw|params|result/i;

export class RollingGatewayMetrics {
  private readonly upstreamResults: TimedResult[] = [];
  private readonly snapshotResults: TimedResult[] = [];
  private readonly reconnectTimes: number[] = [];

  public constructor(private readonly now: () => number = Date.now, private readonly retentionMs = 60 * 60 * 1000) {}

  public recordUpstream(durationMs: number, ok: boolean): void {
    this.upstreamResults.push({ at: this.now(), durationMs, ok });
    this.prune();
  }

  public recordUpstreamTimeout(durationMs: number): void {
    this.upstreamResults.push({ at: this.now(), durationMs, ok: false, timeout: true });
    this.prune();
  }

  public recordSnapshot(durationMs: number, ok: boolean): void {
    this.snapshotResults.push({ at: this.now(), durationMs, ok });
    this.prune();
  }

  public recordReconnect(): void {
    this.reconnectTimes.push(this.now());
    this.prune();
  }

  public snapshot(windowMs = 5 * 60 * 1000): StabilityWindow {
    this.prune();
    const cutoff = this.now() - windowMs;
    const upstream = this.upstreamResults.filter(sample => sample.at >= cutoff);
    const snapshots = this.snapshotResults.filter(sample => sample.at >= cutoff);
    const upstreamFailures = upstream.filter(sample => !sample.ok).length;
    const snapshotFailures = snapshots.filter(sample => !sample.ok).length;
    return {
      windowMs,
      upstream: {
        requests: upstream.length,
        failures: upstreamFailures,
        timeouts: upstream.filter(sample => sample.timeout).length,
        successRate: rate(upstream.length - upstreamFailures, upstream.length),
        p95Ms: percentile(upstream.map(sample => sample.durationMs), 0.95),
        p99Ms: percentile(upstream.map(sample => sample.durationMs), 0.99)
      },
      snapshots: {
        runs: snapshots.length,
        failures: snapshotFailures,
        successRate: rate(snapshots.length - snapshotFailures, snapshots.length),
        p95Ms: percentile(snapshots.map(sample => sample.durationMs), 0.95)
      },
      reconnects: this.reconnectTimes.filter(at => at >= cutoff).length
    };
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    pruneBefore(this.upstreamResults, sample => sample.at >= cutoff);
    pruneBefore(this.snapshotResults, sample => sample.at >= cutoff);
    pruneBefore(this.reconnectTimes, at => at >= cutoff);
  }
}

export class GatewayLogger {
  public readonly fileName: string | null;
  private readonly filePath: string | null;
  private readonly maxBytes: number;
  private queue: Promise<void> = Promise.resolve();

  public constructor(filePath: string | null, maxBytes = 5 * 1024 * 1024) {
    this.filePath = filePath;
    this.fileName = filePath ? basename(filePath) : null;
    this.maxBytes = maxBytes;
  }

  public info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  public error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (!this.filePath) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitizeFields(fields)
    }) + "\n";
    this.queue = this.queue.then(() => this.append(line)).catch(error => {
      console.error(`[gateway-log-error] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async append(line: string): Promise<void> {
    const path = this.filePath;
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    try {
      const current = await stat(path);
      if (current.size + Buffer.byteLength(line, "utf8") > this.maxBytes) {
        await rm(`${path}.1`, { force: true });
        await rename(path, `${path}.1`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendFile(path, line, "utf8");
  }
}

function sanitizeFields(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sanitizeValue(value, key)]));
}

function sanitizeValue(value: unknown, key: string): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeValue(item, "value"));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 497)}...`;
  return value;
}

function rate(successes: number, total: number): number | null {
  return total === 0 ? null : successes / total;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? null;
}

function pruneBefore<T>(values: T[], keep: (value: T) => boolean): void {
  const first = values.findIndex(keep);
  if (first === -1) values.length = 0;
  else if (first > 0) values.splice(0, first);
}
