import { createHash } from "node:crypto";
import {
  AuditLedger,
  applyHumanLock,
  bearer,
  canonicalJson,
  createServer,
  isoNow,
  newId,
  openSse,
  postJson,
  runChpGate,
  sendJson,
  type Principal,
} from "@cubiczan/shared";
import type http from "node:http";
import type { Json } from "@cubiczan/shared";
import {
  GATEWAY_AUDIENCE,
  SCOPE_INVOKE,
  denyScopeIfRequired,
  intersectTools,
  TOKEN_PREFIX,
  mintBearerToken,
  verifyClaimToken,
  type AuthDenyReason,
  type BearerClaims,
} from "./auth.ts";
import { ContextPackStore, resolveSessionId, type AdmitResult } from "./context-pack.ts";
import {
  DEFAULT_TAX_THRESHOLDS,
  groupByServer,
  maxMinRatio,
  measureJson,
  measureToolSchema,
  packTax,
  type ListTax,
  type PackTax,
  type ServerTax,
  type TaxThresholds,
  type ToolTax,
} from "./token-tax.ts";
import {
  builtInCatalog,
  canExpose,
  isMetaTool,
  toListedTool,
  type CatalogTool,
  type ToolImpl,
} from "./tool-catalog.ts";

export interface Credential {
  name: string;
  version: number;
  hash: string;
  preview: string;
  secret?: string;
}

export interface AgentRecord {
  principal: Principal;
  apiKeyHash: string;
  allowlist: string[];
  scopes: string[];
  policyVersion: number;
  spendCapCents: number;
  spendUsedCents: number;
  policyMaxAutoCents: number;
}

export interface PendingLock {
  id: string;
  principalId: string;
  tool: string;
  argHash: string;
  policyVersion: number;
  state: "pending" | "approved" | "rejected" | "consumed";
  createdAt: string;
}

export interface GatewayOptions {
  spendPlaneUrl?: string;
  auditKey?: string;
  tokenKey?: string;
  audience?: string;
  taxThresholds?: Partial<TaxThresholds>;
}

export type AuthOk = {
  ok: true;
  principal: Principal;
  claims: BearerClaims;
  agent: AgentRecord;
};

export type AuthDenied = {
  ok: false;
  reason: AuthDenyReason;
  principalId?: string;
};

export type AuthResult = AuthOk | AuthDenied;

export interface CubiczanMeta {
  principal: Principal;
  allowedTools: string[];
  scopes: string[];
  policyVersion: number;
}

export interface ContextTaxReport {
  heuristic: { bytesPerToken: number };
  thresholds: TaxThresholds;
  generatedAt: string;
  estate: {
    servers: ServerTax[];
    packs: PackTax[];
    tools: ToolTax[];
    ratioMaxMin: number;
    ratioMaxMinTools: number;
    flagged: string[];
  };
  session?: {
    id: string;
    principalId: string;
    tools: string[];
    taxes: ToolTax[];
    tokens: number;
    bytes: number;
    fullAllowlistTokens: number;
    savedTokens: number;
    flagged: boolean;
  };
  sessions?: Array<{ id: string; principalId: string; tools: string[]; tokens: number }>;
  recentLedger: Array<{ event: string; actor: string; inputs: unknown; ts: string }>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function argHash(args: Record<string, Json>): string {
  return hash(canonicalJson(args));
}

function preview(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function asObject(value: Json | undefined): Record<string, Json> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function asStringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function headerSession(req: http.IncomingMessage): string {
  const raw = req.headers["x-cubiczan-session"];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
}

function rpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { rpc: { code, message, data } });
}

export class GovernedGateway {
  readonly ledger: AuditLedger;
  readonly credentials = new Map<string, Credential>();
  readonly agents = new Map<string, AgentRecord>();
  readonly keys = new Map<string, string>();
  readonly locks = new Map<string, PendingLock>();
  readonly catalog = new Map<string, CatalogTool>();
  readonly tools = new Map<string, ToolImpl>();
  readonly packs = new ContextPackStore();
  readonly thresholds: TaxThresholds;
  readonly audience: string;
  readonly tokenKey: string;
  private seq = 0;

  constructor(private readonly options: GatewayOptions = {}) {
    const auditKey = options.auditKey ?? "gateway-demo-key";
    this.ledger = new AuditLedger(auditKey);
    this.tokenKey = options.tokenKey ?? auditKey;
    this.audience = options.audience ?? GATEWAY_AUDIENCE;
    this.thresholds = { ...DEFAULT_TAX_THRESHOLDS, ...options.taxThresholds };
    for (const def of builtInCatalog()) this.catalog.set(def.name, def);

    this.tools.set("echo.ping", (args, principal) => ({
      pong: true,
      echo: args,
      principal,
    }));
    this.tools.set("stripe.charge", (args, principal) => ({
      simulated: true,
      amountCents: args.amountCents ?? 0,
      principal,
    }));
    this.tools.set("search.web", (args, principal) => ({
      hits: [],
      query: args.query ?? "",
      principal,
    }));
    this.tools.set("context.inspect", (args, principal) => this.inspectContext(principal, args));
    this.tools.set("context.need", (args, principal) => this.needContext(principal, args) as unknown as Json);
    this.tools.set("docs.mega_schema", (_args, principal) => {
      const tax = this.toolTax("docs.mega_schema");
      return { accepted: true, principal, tokens: tax?.tokens ?? 0, bytes: tax?.bytes ?? 0 };
    });
  }

  registerTool(def: CatalogTool, impl: ToolImpl): void {
    this.catalog.set(def.name, def);
    this.tools.set(def.name, impl);
  }

  seedDemo(): { agentKey: string; humanKey: string } {
    const agentKey = process.env.GATEWAY_AGENT_KEY ?? "mcp_agt_payops_demo";
    const humanKey = process.env.GATEWAY_HUMAN_KEY ?? "mcp_human_controller_demo";
    const researchKey = process.env.GATEWAY_RESEARCH_KEY ?? "mcp_agt_research_demo";

    this.registerAgent(
      {
        id: "agt_payops",
        kind: "agent",
        orgId: "org_acme",
        displayName: "PayOps Runner",
      },
      agentKey,
      ["echo.ping", "stripe.charge"],
      50_000,
      5_000,
    );
    this.registerAgent(
      {
        id: "agt_research",
        kind: "agent",
        orgId: "org_acme",
        displayName: "Research Scout",
      },
      researchKey,
      ["echo.ping", "search.web"],
      10_000,
      1_000,
    );
    this.registerAgent(
      {
        id: "human.controller",
        kind: "human",
        orgId: "org_acme",
        displayName: "Controller",
      },
      humanKey,
      ["echo.ping"],
      0,
      0,
    );
    this.putCredential("github_token", "ghp_old_secret_aaaa");
    return { agentKey, humanKey };
  }

  registerAgent(
    principal: Principal,
    apiKey: string,
    allowlist: string[],
    spendCapCents: number,
    policyMaxAutoCents: number,
    scopes: string[] = [SCOPE_INVOKE],
  ): void {
    const existing = this.agents.get(principal.id);
    if (existing) this.keys.delete(existing.apiKeyHash);
    const hashed = hash(apiKey);
    this.keys.set(hashed, principal.id);
    this.agents.set(principal.id, {
      principal,
      apiKeyHash: hashed,
      allowlist,
      scopes,
      policyVersion: (existing?.policyVersion ?? 0) + 1,
      spendCapCents,
      spendUsedCents: existing?.spendUsedCents ?? 0,
      policyMaxAutoCents,
    });
  }

  issueToken(claims: Omit<BearerClaims, "v"> & { v?: 1 }): string {
    return mintBearerToken(this.tokenKey, {
      v: 1,
      sub: claims.sub,
      aud: claims.aud,
      scope: claims.scope,
      exp: claims.exp,
      iat: claims.iat,
    });
  }

  putCredential(name: string, secret: string): Credential {
    const existing = this.credentials.get(name);
    const cred: Credential = {
      name,
      version: (existing?.version ?? 0) + 1,
      hash: hash(secret),
      preview: preview(secret),
      secret,
    };
    this.credentials.set(name, cred);
    this.ledger.append({
      event: "credential.put",
      actor: "vault",
      inputs: { name, version: cred.version },
      sources: ["vault"],
    });
    return { ...cred, secret: undefined };
  }

  rotateCredential(name: string, nextSecret: string): Credential {
    const existing = this.credentials.get(name);
    if (!existing) throw new Error(`unknown credential ${name}`);
    return this.putCredential(name, nextSecret);
  }

  verifyCredential(name: string, secret: string): boolean {
    const cred = this.credentials.get(name);
    return Boolean(cred && cred.hash === hash(secret));
  }

  /**
   * Fail-closed Bearer authorization. Never returns a principal on deny.
   * Does not cache the token or principal on a session.
   */
  authenticate(req: http.IncomingMessage, requiredScope?: string): AuthResult {
    const token = bearer(req);
    if (!token) return { ok: false, reason: "missing" };

    if (token.startsWith(`${TOKEN_PREFIX}.`)) {
      const verified = verifyClaimToken(token, this.tokenKey, this.audience);
      if (!verified.ok) return verified;
      const agent = this.agents.get(verified.claims.sub);
      if (!agent) return { ok: false, reason: "invalid" };
      const scopeReason = denyScopeIfRequired(verified.claims.scope, requiredScope);
      if (scopeReason) {
        return { ok: false, reason: scopeReason, principalId: agent.principal.id };
      }
      return { ok: true, principal: agent.principal, claims: verified.claims, agent };
    }

    const id = this.keys.get(hash(token));
    if (!id) return { ok: false, reason: "invalid" };
    const agent = this.agents.get(id);
    if (!agent) return { ok: false, reason: "invalid" };
    const claims: BearerClaims = {
      v: 1,
      sub: agent.principal.id,
      aud: this.audience,
      scope: agent.scopes,
    };
    const scopeReason = denyScopeIfRequired(claims.scope, requiredScope);
    if (scopeReason) {
      return { ok: false, reason: scopeReason, principalId: agent.principal.id };
    }
    return { ok: true, principal: agent.principal, claims, agent };
  }

  resolvePrincipal(req: http.IncomingMessage): Principal | undefined {
    const auth = this.authenticate(req);
    return auth.ok ? auth.principal : undefined;
  }

  grantsFor(auth: AuthOk): CubiczanMeta {
    return {
      principal: auth.principal,
      allowedTools: intersectTools(auth.agent.allowlist, auth.claims.scope),
      scopes: auth.claims.scope,
      policyVersion: auth.agent.policyVersion,
    };
  }

  attachPrincipal(
    payload: Record<string, Json>,
    principal: Principal,
    grants?: Omit<CubiczanMeta, "principal">,
  ): Record<string, Json> {
    const params = asObject(payload.params);
    const meta = asObject(params._meta);
    const cubiczan = asObject(meta.cubiczan);
    cubiczan.principal = principal as unknown as Json;
    if (grants) {
      cubiczan.allowedTools = grants.allowedTools as unknown as Json;
      cubiczan.scopes = grants.scopes as unknown as Json;
      cubiczan.policyVersion = grants.policyVersion;
    }
    meta.cubiczan = cubiczan;
    params._meta = meta;
    return { ...payload, params };
  }

  recordDecision(input: {
    decision: "allow" | "deny";
    tool: string;
    argHash: string;
    principalId: string;
    policyVersion: number;
    reason?: string;
  }) {
    return this.ledger.append({
      event: "authz.decision",
      actor: input.principalId,
      inputs: {
        decision: input.decision,
        tool: input.tool,
        argHash: input.argHash,
        principalId: input.principalId,
        policyVersion: input.policyVersion,
        reason: input.reason ?? input.decision,
      },
      sources: ["authz"],
    });
  }

  applyLock(lockId: string, decision: "approve" | "reject", notes?: string) {
    const lock = this.locks.get(lockId);
    if (!lock) throw new Error("unknown lock");
    if (lock.state !== "pending") throw new Error(`lock is ${lock.state}`);
    const outcome = applyHumanLock(decision, notes);
    lock.state = decision === "approve" ? "approved" : "rejected";
    this.ledger.append({
      event: "chp.lock",
      actor: lock.principalId,
      inputs: { lockId, decision, tool: lock.tool, argHash: lock.argHash },
      sources: ["chp", "human"],
      rationale: outcome.rationale,
    });
    return { ...outcome, lockId, tool: lock.tool, argHash: lock.argHash, lockState: lock.state };
  }

  sessionIdFor(principal: Principal, params: Record<string, Json>, req?: http.IncomingMessage): string {
    const meta = asObject(asObject(params._meta).cubiczan);
    return resolveSessionId(
      principal.id,
      typeof params.sessionId === "string" ? params.sessionId : undefined,
      req ? headerSession(req) : "",
      typeof meta.sessionId === "string" ? meta.sessionId : undefined,
    );
  }

  allowlistOf(principal: Principal): string[] {
    return this.agents.get(principal.id)?.allowlist ?? [];
  }

  toolTax(name: string): ToolTax | undefined {
    const def = this.catalog.get(name);
    if (!def) return undefined;
    return measureToolSchema(def, this.thresholds.toolTokens);
  }

  estateTaxes(): ToolTax[] {
    return [...this.catalog.values()].map((def) => measureToolSchema(def, this.thresholds.toolTokens));
  }

  estateReport(): ContextTaxReport["estate"] {
    const tools = this.estateTaxes();
    const servers = groupByServer(tools, this.thresholds.packTokens);
    const byPack = new Map<string, ToolTax[]>();
    for (const tool of tools) {
      const list = byPack.get(tool.pack) ?? [];
      list.push(tool);
      byPack.set(tool.pack, list);
    }
    const packs = [...byPack.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, grouped]) => packTax(id, grouped, this.thresholds.packTokens));
    const flagged = [
      ...tools.filter((t) => t.oversized).map((t) => t.name),
      ...packs.filter((p) => p.flagged).map((p) => `pack:${p.id}`),
    ];
    return {
      servers,
      packs,
      tools,
      ratioMaxMin: maxMinRatio(servers.map((s) => s.tokens)),
      ratioMaxMinTools: maxMinRatio(tools.map((t) => t.tokens)),
      flagged,
    };
  }

  contextTaxReport(principal: Principal, sessionId?: string): ContextTaxReport {
    const sid = sessionId ?? `ses_${principal.id}`;
    const catalog = [...this.catalog.values()];
    const session = this.packs.ensure(sid, principal.id, this.allowlistOf(principal), catalog);
    const taxes = session.tools
      .map((name) => this.toolTax(name))
      .filter((tax): tax is ToolTax => Boolean(tax));
    const bytes = taxes.reduce((n, t) => n + t.bytes, 0);
    const tokens = taxes.reduce((n, t) => n + t.tokens, 0);
    const fullAllowlistTokens = this.fullAllowlistTokens(principal);
    const estate = this.estateReport();
    const sessions =
      principal.kind === "human"
        ? [...this.packs.sessions.values()].map((s) => ({
            id: s.id,
            principalId: s.principalId,
            tools: s.tools,
            tokens: s.tools.reduce((n, name) => n + (this.toolTax(name)?.tokens ?? 0), 0),
          }))
        : undefined;
    return {
      heuristic: { bytesPerToken: 4 },
      thresholds: this.thresholds,
      generatedAt: isoNow(),
      estate,
      session: {
        id: session.id,
        principalId: session.principalId,
        tools: session.tools,
        taxes,
        tokens,
        bytes,
        fullAllowlistTokens,
        savedTokens: Math.max(0, fullAllowlistTokens - tokens),
        flagged: tokens >= this.thresholds.packTokens || taxes.some((t) => t.oversized),
      },
      sessions,
      recentLedger: this.ledger.records
        .filter((r) => r.event.startsWith("schema."))
        .slice(-20)
        .map((r) => ({ event: r.event, actor: r.actor, inputs: r.inputs, ts: r.ts })),
    };
  }

  fullAllowlistTokens(principal: Principal): number {
    const names = new Set([...this.allowlistOf(principal), ...["context.inspect", "context.need"]]);
    return [...names].reduce((n, name) => n + (this.toolTax(name)?.tokens ?? 0), 0);
  }

  admitNeed(
    principal: Principal,
    sessionId: string,
    request: { tools?: string[]; pack?: string },
  ): AdmitResult {
    const result = this.packs.admit(
      sessionId,
      principal.id,
      this.allowlistOf(principal),
      [...this.catalog.values()],
      request,
    );
    if (result.admitted.length > 0) {
      this.ledger.append({
        event: "schema.pack.opened",
        actor: principal.id,
        inputs: { sessionId, admitted: result.admitted, pack: request.pack ?? null },
        sources: ["context-pack", "allowlist"],
      });
    }
    if (result.denied.length > 0) {
      this.ledger.append({
        event: "schema.pack.denied",
        actor: principal.id,
        inputs: { sessionId, denied: result.denied, pack: request.pack ?? null },
        sources: ["allowlist"],
      });
    }
    return result;
  }

  listTools(
    principal: Principal,
    params: Record<string, Json>,
    req?: http.IncomingMessage,
    grants?: Omit<CubiczanMeta, "principal">,
  ): {
    tools: Array<{ name: string; description: string; inputSchema: Json }>;
    _meta: {
      cubiczan: {
        principal: Principal;
        sessionId: string;
        tax: ListTax;
        allowedTools?: string[];
        scopes?: string[];
        policyVersion?: number;
      };
    };
  } {
    const sessionId = this.sessionIdFor(principal, params, req);
    const catalog = [...this.catalog.values()];
    const allowlist = this.allowlistOf(principal);
    const session = this.packs.ensure(sessionId, principal.id, allowlist, catalog);
    const need = asStringArray(params.need);
    const pack = typeof params.pack === "string" ? params.pack : undefined;
    if (need.length > 0 || pack) this.admitNeed(principal, sessionId, { tools: need, pack });

    const mode = params.mode === "full" ? "full" : "pack";
    const names =
      mode === "full"
        ? [...new Set([...allowlist, "context.inspect", "context.need"])]
        : session.tools.filter((name) => canExpose(name, allowlist));

    const listed = names
      .map((name) => this.catalog.get(name))
      .filter((def): def is CatalogTool => Boolean(def))
      .map(toListedTool);
    const payload = measureJson(listed);
    const fullAllowlistTokens = this.fullAllowlistTokens(principal);
    const warnings: string[] = [];
    const flagged = payload.tokens >= this.thresholds.listTokens;
    if (flagged) warnings.push(`listed payload ${payload.tokens} tokens exceeds ${this.thresholds.listTokens}`);
    for (const name of names) {
      const tax = this.toolTax(name);
      if (tax?.oversized) warnings.push(`tool ${name} is oversized (${tax.tokens} tokens)`);
    }

    const tax: ListTax = {
      bytes: payload.bytes,
      tokens: payload.tokens,
      toolCount: listed.length,
      fullAllowlistTokens,
      savedTokens: mode === "full" ? 0 : Math.max(0, fullAllowlistTokens - payload.tokens),
      flagged,
      mode,
      warnings,
    };

    this.ledger.append({
      event: "schema.tax.recorded",
      actor: principal.id,
      inputs: { sessionId, mode, bytes: tax.bytes, tokens: tax.tokens, toolCount: tax.toolCount, flagged },
      sources: ["tools/list", "token-tax"],
    });
    if (flagged || warnings.length > 0) {
      this.ledger.append({
        event: "schema.pack.flagged",
        actor: principal.id,
        inputs: { sessionId, mode, warnings },
        sources: ["token-tax"],
      });
    }

    return {
      tools: listed,
      _meta: {
        cubiczan: {
          principal,
          sessionId,
          tax,
          ...(grants
            ? {
                allowedTools: grants.allowedTools,
                scopes: grants.scopes,
                policyVersion: grants.policyVersion,
              }
            : {}),
        },
      },
    };
  }

  inspectContext(principal: Principal, args: Record<string, Json>): Json {
    const sessionId =
      typeof args.sessionId === "string" && args.sessionId
        ? args.sessionId
        : `ses_${principal.id}`;
    const report = this.contextTaxReport(principal, sessionId);
    if (args.includeEstate === false) {
      const { estate: _estate, ...rest } = report;
      return rest as unknown as Json;
    }
    return report as unknown as Json;
  }

  needContext(principal: Principal, args: Record<string, Json>): AdmitResult {
    const sessionId =
      typeof args.sessionId === "string" && args.sessionId
        ? args.sessionId
        : `ses_${principal.id}`;
    return this.admitNeed(principal, sessionId, {
      tools: asStringArray(args.tools),
      pack: typeof args.pack === "string" ? args.pack : undefined,
    });
  }

  async dispatchTool(
    principal: Principal,
    name: string,
    args: Record<string, Json>,
    grants?: Omit<CubiczanMeta, "principal">,
  ): Promise<Json> {
    const agent = this.agents.get(principal.id);
    if (!agent) throw new Error("unknown principal");
    const digest = argHash(args);
    const policyVersion = grants?.policyVersion ?? agent.policyVersion;
    const allowedTools = grants?.allowedTools ?? intersectTools(agent.allowlist, agent.scopes);
    const scopes = grants?.scopes ?? agent.scopes;

    if (!canExpose(name, agent.allowlist) || (!isMetaTool(name) && !allowedTools.includes(name))) {
      this.recordDecision({
        decision: "deny",
        tool: name,
        argHash: digest,
        principalId: principal.id,
        policyVersion,
        reason: "allowlist",
      });
      throw rpcError(-32001, `tool ${name} is not on the allowlist`);
    }
    if (!isMetaTool(name) && !intersectTools(agent.allowlist, scopes).includes(name)) {
      this.recordDecision({
        decision: "deny",
        tool: name,
        argHash: digest,
        principalId: principal.id,
        policyVersion,
        reason: "wrong_scope",
      });
      throw rpcError(-32001, `tool ${name} is not in the token scope`);
    }

    const related = [...this.locks.values()].filter(
      (lock) => lock.principalId === principal.id && lock.tool === name,
    );
    const unusedApproved = related.find((lock) => lock.state === "approved");
    if (unusedApproved && unusedApproved.argHash !== digest) {
      this.recordDecision({
        decision: "deny",
        tool: name,
        argHash: digest,
        principalId: principal.id,
        policyVersion,
        reason: "changed_arguments",
      });
      throw rpcError(-32006, "changed_arguments", {
        expectedArgHash: unusedApproved.argHash,
        argHash: digest,
        lockId: unusedApproved.id,
      });
    }

    const consumed = related.find((lock) => lock.state === "consumed" && lock.argHash === digest);
    if (consumed && !unusedApproved) {
      this.recordDecision({
        decision: "deny",
        tool: name,
        argHash: digest,
        principalId: principal.id,
        policyVersion,
        reason: "replay",
      });
      throw rpcError(-32007, "replay", { lockId: consumed.id, argHash: digest });
    }

    let usedApprovedLock = false;
    if (unusedApproved && unusedApproved.argHash === digest) {
      unusedApproved.state = "consumed";
      usedApprovedLock = true;
    }

    const amountCents = Number(args.amountCents ?? 0) || 0;
    const chp = runChpGate({
      action: name,
      amountCents,
      principal,
      policyMaxAutoCents: agent.policyMaxAutoCents,
      spendCapCents: agent.spendCapCents,
      spendUsedCents: agent.spendUsedCents,
      allowed: true,
      blocked: false,
      scoped: name.includes("."),
    });
    if (chp.state === "REJECTED" && !usedApprovedLock) {
      this.recordDecision({
        decision: "deny",
        tool: name,
        argHash: digest,
        principalId: principal.id,
        policyVersion,
        reason: "chp_rejected",
      });
      throw rpcError(-32003, chp.rationale, chp);
    }
    if (!usedApprovedLock && chp.state !== "LOCKED" && name === "stripe.charge") {
      const lock: PendingLock = {
        id: newId("lck"),
        principalId: principal.id,
        tool: name,
        argHash: digest,
        policyVersion,
        state: "pending",
        createdAt: new Date().toISOString(),
      };
      this.locks.set(lock.id, lock);
      throw rpcError(-32004, "pending_human", { ...chp, lockId: lock.id, argHash: digest });
    }

    if (this.options.spendPlaneUrl && amountCents > 0) {
      const hooked = await postJson(
        this.options.spendPlaneUrl,
        "/v1/proposals",
        {
          agent: principal.id,
          kind: "purchase",
          merchant: { name: "stripe", url: "https://stripe.com", country: "US" },
          total: (amountCents / 100).toFixed(2),
          currency: "USD",
          items: [{ description: name, unit_price: (amountCents / 100).toFixed(2), quantity: 1 }],
          rationale: `MCP tool ${name}`,
        },
        process.env.SPEND_AGENT_KEY,
      );
      const lane = asObject(hooked.json).lane;
      if (lane === "blocked") {
        throw rpcError(-32005, "blocked by spend plane", hooked.json);
      }
    }

    const impl = this.tools.get(name);
    if (!impl) throw new Error(`unknown tool ${name}`);
    const result = impl(args, principal);
    this.recordDecision({
      decision: "allow",
      tool: name,
      argHash: digest,
      principalId: principal.id,
      policyVersion,
      reason: usedApprovedLock ? "human_lock" : "allow",
    });
    this.ledger.append({
      event: "tool.called",
      actor: principal.id,
      inputs: { name, amountCents, argHash: digest },
      sources: ["mcp", "chp"],
      rationale: chp.rationale,
    });
    return result;
  }

  createHttpServer(): http.Server {
    return createServer(async (req, res, url, body) => {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "governed-mcp-gateway" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/mcp/sse") {
        const auth = this.authenticate(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
          return;
        }
        const cubiczan = this.grantsFor(auth);
        const sse = openSse(res);
        this.seq += 1;
        const frame = {
          jsonrpc: "2.0",
          method: "notifications/message",
          params: {
            level: "info",
            message: "sse-open",
            _meta: { cubiczan },
          },
        };
        sse.send("message", frame, String(this.seq));
        if (url.searchParams.get("once") === "1") sse.close();
        return;
      }

      const obj = asObject(body);

      if (req.method === "GET" && url.pathname === "/v1/context/tax") {
        const auth = this.authenticate(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
          return;
        }
        const sessionId = url.searchParams.get("session") ?? undefined;
        sendJson(res, 200, this.contextTaxReport(auth.principal, sessionId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/context/packs") {
        const auth = this.authenticate(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
          return;
        }
        const estate = this.estateReport();
        sendJson(res, 200, {
          heuristic: { bytesPerToken: 4 },
          thresholds: this.thresholds,
          packs: estate.packs,
          servers: estate.servers,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/context/need") {
        const auth = this.authenticate(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
          return;
        }
        const sessionId = this.sessionIdFor(auth.principal, obj, req);
        sendJson(res, 200, this.admitNeed(auth.principal, sessionId, {
          tools: asStringArray(obj.tools),
          pack: typeof obj.pack === "string" ? obj.pack : undefined,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/credentials") {
        const auth = this.authenticate(req);
        if (!auth.ok || auth.principal.kind === "agent") {
          sendJson(res, 401, { error: "operator required", reason: auth.ok ? "operator_required" : auth.reason });
          return;
        }
        const name = String(obj.name ?? "");
        const secret = String(obj.secret ?? "");
        if (!name || !secret) {
          sendJson(res, 400, { error: "name and secret required" });
          return;
        }
        sendJson(res, 200, this.putCredential(name, secret));
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/v1/credentials/") && url.pathname.endsWith("/rotate")) {
        const auth = this.authenticate(req);
        if (!auth.ok || auth.principal.kind === "agent") {
          sendJson(res, 401, { error: "operator required", reason: auth.ok ? "operator_required" : auth.reason });
          return;
        }
        const name = url.pathname.split("/")[3];
        const secret = String(obj.secret ?? newId("tok"));
        try {
          sendJson(res, 200, { ...this.rotateCredential(name, secret), secret });
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/credentials/verify") {
        const name = String(obj.name ?? "");
        const secret = String(obj.secret ?? "");
        sendJson(res, 200, { ok: this.verifyCredential(name, secret) });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/")) {
        const method = String(obj.method ?? "");
        const id = obj.id ?? null;

        if (method === "initialize") {
          const auth = this.authenticate(req);
          if (!auth.ok) {
            this.recordDecision({
              decision: "deny",
              tool: "",
              argHash: "",
              principalId: "anonymous",
              policyVersion: 0,
              reason: auth.reason,
            });
            sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "governed-mcp-gateway", version: "0.1.0" },
              capabilities: { tools: {}, logging: {} },
            },
          });
          return;
        }

        if (method === "tools/list") {
          const auth = this.authenticate(req);
          if (!auth.ok) {
            this.recordDecision({
              decision: "deny",
              tool: "",
              argHash: "",
              principalId: "anonymous",
              policyVersion: 0,
              reason: auth.reason,
            });
            sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
            return;
          }
          const grants = this.grantsFor(auth);
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: this.listTools(auth.principal, asObject(obj.params), req, grants),
          });
          return;
        }

        if (method === "tools/call") {
          const previewParams = asObject(obj.params);
          const name = String(previewParams.name ?? "");
          const auth = this.authenticate(req, isMetaTool(name) ? undefined : name || undefined);
          if (!auth.ok) {
            this.recordDecision({
              decision: "deny",
              tool: name,
              argHash: argHash(asObject(previewParams.arguments)),
              principalId: auth.principalId ?? "anonymous",
              policyVersion: 0,
              reason: auth.reason,
            });
            sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
            return;
          }
          const grants = this.grantsFor(auth);
          const attached = this.attachPrincipal(obj, auth.principal, grants);
          const params = asObject(attached.params);
          const args = asObject(params.arguments);
          try {
            const result = await this.dispatchTool(auth.principal, name, args, grants);
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
                _meta: { cubiczan: grants },
                structuredContent: result,
              },
            });
          } catch (error) {
            const rpc = (error as { rpc?: { code: number; message: string; data?: unknown } }).rpc;
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              error: rpc ?? { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
          }
          return;
        }

        const auth = this.authenticate(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
          return;
        }
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown method ${method}` },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/locks") {
        const auth = this.authenticate(req);
        if (!auth.ok || auth.principal.kind === "agent") {
          sendJson(res, 401, { error: "human required", reason: auth.ok ? "human_required" : auth.reason });
          return;
        }
        const lockId = String(obj.lockId ?? "");
        if (!lockId) {
          sendJson(res, 400, { error: "lockId required" });
          return;
        }
        const decision = obj.decision === "reject" ? "reject" : "approve";
        try {
          sendJson(res, 200, this.applyLock(lockId, decision, String(obj.notes ?? "")));
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    });
  }
}
