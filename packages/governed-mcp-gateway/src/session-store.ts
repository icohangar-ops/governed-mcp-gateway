import { isoNow } from "@cubiczan/shared";

/** Streamable HTTP / pack session record shared across replicas when the store is. */
export interface SessionRecord {
  id: string;
  replicaId: string;
  principalId: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Actionable fail-closed codes for missing or unrecoverable MCP sessions.
 * Names align with silent-probe style reason codes (MISSING_SESSION, SESSION_STICKY_MISMATCH).
 */
export type SessionReasonCode =
  | "MISSING_SESSION"
  | "SESSION_STICKY_MISMATCH"
  | "UNKNOWN_SESSION"
  | "SESSION_PRINCIPAL_MISMATCH";

export type SessionMode = "stateless" | "sticky" | "shared";

export const SESSION_REASON = {
  MISSING_SESSION: "MISSING_SESSION",
  SESSION_STICKY_MISMATCH: "SESSION_STICKY_MISMATCH",
  UNKNOWN_SESSION: "UNKNOWN_SESSION",
  SESSION_PRINCIPAL_MISMATCH: "SESSION_PRINCIPAL_MISMATCH",
} as const satisfies Record<SessionReasonCode, SessionReasonCode>;

export const SESSION_RPC_CODE = -32020;

export interface SessionDenied {
  reason: SessionReasonCode;
  message: string;
  httpStatus: number;
  sessionId?: string;
  hint: string;
}

export interface SessionStore {
  get(id: string): SessionRecord | undefined;
  put(record: SessionRecord): void;
  delete(id: string): boolean;
  values(): Iterable<SessionRecord>;
}

/** In-process store for tests and single-replica sticky mode. Not a Redis client. */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(id: string): SessionRecord | undefined {
    const found = this.records.get(id);
    return found ? { ...found, tools: [...found.tools] } : undefined;
  }

  put(record: SessionRecord): void {
    this.records.set(record.id, {
      ...record,
      tools: [...record.tools],
      updatedAt: record.updatedAt,
    });
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  values(): Iterable<SessionRecord> {
    return [...this.records.values()].map((record) => ({ ...record, tools: [...record.tools] }));
  }
}

/** Minimal Redis-compatible surface so operators can wrap ioredis without a live client in CI. */
export interface RedisLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  keys?(prefix: string): string[];
}

export class MapRedisLike implements RedisLike {
  private readonly data = new Map<string, string>();

  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }

  del(key: string): void {
    this.data.delete(key);
  }

  keys(prefix: string): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix));
  }
}

/** Session store backed by a Redis-like key/value (Map in tests, ioredis in production). */
export class KeyValueSessionStore implements SessionStore {
  constructor(
    private readonly kv: RedisLike,
    private readonly prefix = "mcp:session:",
  ) {}

  get(id: string): SessionRecord | undefined {
    const raw = this.kv.get(`${this.prefix}${id}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as SessionRecord;
  }

  put(record: SessionRecord): void {
    this.kv.set(`${this.prefix}${record.id}`, JSON.stringify(record));
  }

  delete(id: string): boolean {
    const existed = this.get(id) !== undefined;
    this.kv.del(`${this.prefix}${id}`);
    return existed;
  }

  values(): Iterable<SessionRecord> {
    const keys = this.kv.keys?.(this.prefix) ?? [];
    const out: SessionRecord[] = [];
    for (const key of keys) {
      const record = this.get(key.slice(this.prefix.length));
      if (record) out.push(record);
    }
    return out;
  }
}

export function parseSessionMode(raw?: string): SessionMode {
  const value = (raw ?? "stateless").trim().toLowerCase();
  if (value === "stateless" || value === "sticky" || value === "shared") return value;
  throw new Error(`unknown MCP_SESSION_MODE ${raw}`);
}

export function defaultReplicaId(raw?: string): string {
  return raw?.trim() || process.env.MCP_REPLICA_ID?.trim() || process.env.HOSTNAME?.trim() || "gw-local";
}

export function requiresTransportSession(mode: SessionMode): boolean {
  return mode === "sticky" || mode === "shared";
}

export function sessionDenied(
  reason: SessionReasonCode,
  message: string,
  extras: { sessionId?: string; hint: string; httpStatus?: number },
): SessionDenied {
  const httpStatus =
    extras.httpStatus ??
    (reason === SESSION_REASON.MISSING_SESSION || reason === SESSION_REASON.SESSION_PRINCIPAL_MISMATCH ? 400 : 404);
  return {
    reason,
    message,
    httpStatus,
    sessionId: extras.sessionId,
    hint: extras.hint,
  };
}

export function touchSession(record: SessionRecord, patch: Partial<Pick<SessionRecord, "tools" | "replicaId">>): SessionRecord {
  return {
    ...record,
    ...patch,
    tools: patch.tools ? [...patch.tools] : [...record.tools],
    updatedAt: isoNow(),
  };
}
