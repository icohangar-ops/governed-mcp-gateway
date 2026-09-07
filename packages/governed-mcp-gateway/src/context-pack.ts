import { isoNow } from "@cubiczan/shared";
import { canExpose, defaultSeedTools, isMetaTool, namesInPack, type CatalogTool } from "./tool-catalog.ts";
import {
  InMemorySessionStore,
  type SessionRecord,
  type SessionStore,
} from "./session-store.ts";

export interface SessionPack {
  id: string;
  principalId: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
  replicaId?: string;
}

export interface AdmitResult {
  sessionId: string;
  admitted: string[];
  denied: string[];
  tools: string[];
}

export function resolveSessionId(
  principalId: string,
  requested?: string,
  header?: string,
  metaSession?: string,
): string {
  const raw = requested?.trim() || metaSession?.trim() || header?.trim();
  return raw && raw.length > 0 ? raw : `ses_${principalId}`;
}

function asPack(record: SessionRecord): SessionPack {
  return {
    id: record.id,
    principalId: record.principalId,
    tools: [...record.tools],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    replicaId: record.replicaId,
  };
}

export class ContextPackStore {
  readonly store: SessionStore;
  readonly replicaId: string;

  constructor(options: { store?: SessionStore; replicaId?: string } = {}) {
    this.store = options.store ?? new InMemorySessionStore();
    this.replicaId = options.replicaId ?? "local";
  }

  /** Snapshot of pack sessions (human inspector / tests). */
  get sessions(): Map<string, SessionPack> {
    return new Map([...this.store.values()].map((record) => [record.id, asPack(record)]));
  }

  get(sessionId: string): SessionPack | undefined {
    const found = this.store.get(sessionId);
    return found ? asPack(found) : undefined;
  }

  getOrCreate(sessionId: string, principalId: string, seed: string[]): SessionPack {
    const existing = this.store.get(sessionId);
    if (existing) {
      if (existing.principalId !== principalId) {
        throw Object.assign(new Error("session belongs to another principal"), { code: "session_mismatch" });
      }
      return asPack(existing);
    }
    const now = isoNow();
    const created: SessionRecord = {
      id: sessionId,
      replicaId: this.replicaId,
      principalId,
      tools: [...new Set(seed)],
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(created);
    return asPack(created);
  }

  ensure(sessionId: string, principalId: string, allowlist: string[], catalog: readonly CatalogTool[]): SessionPack {
    const existing = this.store.get(sessionId);
    if (existing) {
      if (existing.principalId !== principalId) {
        throw Object.assign(new Error("session belongs to another principal"), { code: "session_mismatch" });
      }
      return asPack(existing);
    }
    return this.getOrCreate(sessionId, principalId, defaultSeedTools(allowlist, catalog));
  }

  admit(
    sessionId: string,
    principalId: string,
    allowlist: string[],
    catalog: readonly CatalogTool[],
    request: { tools?: string[]; pack?: string },
  ): AdmitResult {
    const session = this.ensure(sessionId, principalId, allowlist, catalog);
    const wanted = new Set<string>(request.tools ?? []);
    if (request.pack) {
      for (const name of namesInPack(catalog, request.pack)) wanted.add(name);
    }

    const admitted: string[] = [];
    const denied: string[] = [];
    const have = new Set(session.tools);
    const known = new Set(catalog.map((tool) => tool.name));

    for (const name of wanted) {
      if (have.has(name)) {
        admitted.push(name);
        continue;
      }
      if (!canExpose(name, allowlist)) {
        denied.push(name);
        continue;
      }
      if (!known.has(name) && !isMetaTool(name)) {
        denied.push(name);
        continue;
      }
      have.add(name);
      admitted.push(name);
    }

    const tools = [...have];
    const existing = this.store.get(sessionId);
    if (existing) {
      this.store.put({
        ...existing,
        tools,
        updatedAt: isoNow(),
      });
    }
    return { sessionId, admitted, denied, tools };
  }
}
