import { isoNow } from "@cubiczan/shared";
import { canExpose, defaultSeedTools, isMetaTool, namesInPack, type CatalogTool } from "./tool-catalog.ts";

export interface SessionPack {
  id: string;
  principalId: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
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

export class ContextPackStore {
  readonly sessions = new Map<string, SessionPack>();

  get(sessionId: string): SessionPack | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(sessionId: string, principalId: string, seed: string[]): SessionPack {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.principalId !== principalId) {
        throw Object.assign(new Error("session belongs to another principal"), { code: "session_mismatch" });
      }
      return existing;
    }
    const now = isoNow();
    const created: SessionPack = {
      id: sessionId,
      principalId,
      tools: [...new Set(seed)],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  ensure(sessionId: string, principalId: string, allowlist: string[], catalog: readonly CatalogTool[]): SessionPack {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.principalId !== principalId) {
        throw Object.assign(new Error("session belongs to another principal"), { code: "session_mismatch" });
      }
      return existing;
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

    session.tools = [...have];
    session.updatedAt = isoNow();
    return { sessionId, admitted, denied, tools: [...session.tools] };
  }
}
