import { createHash } from "node:crypto";
import {
  AuditLedger,
  applyHumanLock,
  bearer,
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
import { ContextPackStore, resolveSessionId, type AdmitResult } from "./context-pack.ts";
import {
  bindHostBindings,
  claimedPrincipalConflict,
  inventedHostKeys,
  stripHostOnlyKeys,
  type HostBindResult,
  type HostBindings,
} from "./host-meta.ts";
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
  spendCapCents: number;
  spendUsedCents: number;
  policyMaxAutoCents: number;
}

export interface GatewayOptions {
  spendPlaneUrl?: string;
  auditKey?: string;
  taxThresholds?: Partial<TaxThresholds>;
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

export class GovernedGateway {
  readonly ledger: AuditLedger;
  readonly credentials = new Map<string, Credential>();
  readonly agents = new Map<string, AgentRecord>();
  readonly keys = new Map<string, string>();
  readonly catalog = new Map<string, CatalogTool>();
  readonly tools = new Map<string, ToolImpl>();
  readonly packs = new ContextPackStore();
  readonly thresholds: TaxThresholds;
  private seq = 0;

  constructor(private readonly options: GatewayOptions = {}) {
    this.ledger = new AuditLedger(options.auditKey ?? "gateway-demo-key");
    this.thresholds = { ...DEFAULT_TAX_THRESHOLDS, ...options.taxThresholds };
    for (const def of builtInCatalog()) this.catalog.set(def.name, def);

    this.tools.set("echo.ping", (args, principal, host) => ({
      pong: true,
      echo: args,
      principal,
      host,
    }));
    this.tools.set("stripe.charge", (args, principal, host) => ({
      simulated: true,
      amountCents: args.amountCents ?? 0,
      principal,
      host,
    }));
    this.tools.set("search.web", (args, principal, host) => ({
      hits: [],
      query: args.query ?? "",
      principal,
      host,
    }));
    this.tools.set("index.query", (args, principal, host) => ({
      hits: [],
      query: args.query ?? "",
      tenant: host.tenant,
      index: host.index,
      principal,
      host,
    }));
    this.tools.set("context.inspect", (args, principal) => this.inspectContext(principal, args));
    this.tools.set("context.need", (args, principal) => this.needContext(principal, args) as unknown as Json);
    this.tools.set("docs.mega_schema", (_args, principal, host) => {
      const tax = this.toolTax("docs.mega_schema");
      return { accepted: true, principal, host, tokens: tax?.tokens ?? 0, bytes: tax?.bytes ?? 0 };
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
      ["echo.ping", "stripe.charge", "index.query"],
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
      ["echo.ping", "search.web", "index.query"],
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
  ): void {
    const hashed = hash(apiKey);
    this.keys.set(hashed, principal.id);
    this.agents.set(principal.id, {
      principal,
      apiKeyHash: hashed,
      allowlist,
      spendCapCents,
      spendUsedCents: 0,
      policyMaxAutoCents,
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

  resolvePrincipal(req: http.IncomingMessage): Principal | undefined {
    const token = bearer(req);
    if (!token) return undefined;
    const id = this.keys.get(hash(token));
    if (!id) return undefined;
    return this.agents.get(id)?.principal;
  }

  attachPrincipal(
    payload: Record<string, Json>,
    principal: Principal,
    host?: HostBindings,
  ): Record<string, Json> {
    const params = asObject(payload.params);
    const meta = asObject(params._meta);
    const cubiczan = asObject(meta.cubiczan);
    cubiczan.principal = principal as unknown as Json;
    if (host) cubiczan.host = host as unknown as Json;
    meta.cubiczan = cubiczan;
    params._meta = meta;
    return { ...payload, params };
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

  private headerValue(req: http.IncomingMessage | undefined, name: string): string {
    if (!req) return "";
    const raw = req.headers[name];
    return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
  }

  private queryValue(req: http.IncomingMessage | undefined, name: string): string {
    if (!req) return "";
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    return url.searchParams.get(name) ?? "";
  }

  hostBindingsFor(
    principal: Principal,
    params: Record<string, Json>,
    req?: http.IncomingMessage,
  ): HostBindResult {
    const hostMeta = asObject(asObject(asObject(params._meta).cubiczan).host);
    return bindHostBindings({
      principal,
      tenantClaim: {
        header: this.headerValue(req, "x-cubiczan-tenant"),
        query: this.queryValue(req, "tenant"),
        meta: typeof hostMeta.tenant === "string" ? hostMeta.tenant : "",
      },
      indexClaim: {
        header: this.headerValue(req, "x-cubiczan-index"),
        query: this.queryValue(req, "index"),
        meta: typeof hostMeta.index === "string" ? hostMeta.index : "",
      },
      vault: [...this.credentials.values()].map((cred) => ({ name: cred.name, version: cred.version })),
    });
  }

  denyHost(principal: Principal, reason: string, invented: string[], name?: string): never {
    this.ledger.append({
      event: "host.meta.denied",
      actor: principal.id,
      inputs: { reason, invented, name: name ?? null },
      sources: ["host-meta"],
    });
    throw Object.assign(new Error(reason), {
      rpc: { code: -32006, message: reason, data: { invented } },
    });
  }

  allowlistOf(principal: Principal): string[] {
    return this.agents.get(principal.id)?.allowlist ?? [];
  }

  toolTax(name: string): ToolTax | undefined {
    const def = this.catalog.get(name);
    if (!def) return undefined;
    const listed = toListedTool(def);
    return measureToolSchema({ ...def, ...listed }, this.thresholds.toolTokens);
  }

  estateTaxes(): ToolTax[] {
    return [...this.catalog.values()].map((def) => {
      const listed = toListedTool(def);
      return measureToolSchema({ ...def, ...listed }, this.thresholds.toolTokens);
    });
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

  listTools(principal: Principal, params: Record<string, Json>, req?: http.IncomingMessage): {
    tools: Array<{ name: string; description: string; inputSchema: Json }>;
    _meta: { cubiczan: { principal: Principal; sessionId: string; tax: ListTax; host: HostBindings } };
  } {
    const sessionId = this.sessionIdFor(principal, params, req);
    const catalog = [...this.catalog.values()];
    const session = this.packs.ensure(sessionId, principal.id, this.allowlistOf(principal), catalog);
    const need = asStringArray(params.need);
    const pack = typeof params.pack === "string" ? params.pack : undefined;
    if (need.length > 0 || pack) this.admitNeed(principal, sessionId, { tools: need, pack });

    const mode = params.mode === "full" ? "full" : "pack";
    const allowlist = this.allowlistOf(principal);
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

    const hostBound = this.hostBindingsFor(principal, params, req);
    if (!hostBound.ok) this.denyHost(principal, hostBound.reason, hostBound.invented, "tools/list");

    return {
      tools: listed,
      _meta: { cubiczan: { principal, sessionId, tax, host: hostBound.host } },
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
    host: HostBindings,
  ): Promise<Json> {
    const agent = this.agents.get(principal.id);
    if (!agent) throw new Error("unknown principal");
    if (!canExpose(name, agent.allowlist)) {
      const error = { code: -32001, message: `tool ${name} is not on the allowlist` };
      this.ledger.append({
        event: "tool.denied",
        actor: principal.id,
        inputs: { name },
        sources: ["allowlist"],
      });
      throw Object.assign(new Error(error.message), { rpc: error });
    }

    const def = this.catalog.get(name);
    const extraHostKeys = [...(def?.hostOnly ?? []), ...this.credentials.keys()];
    const invented = inventedHostKeys(args, extraHostKeys);
    if (invented.length > 0) {
      stripHostOnlyKeys(args, extraHostKeys);
      this.denyHost(principal, `model invented host-only argument(s): ${invented.join(", ")}`, invented, name);
    }
    for (const key of def?.hostOnly ?? []) {
      if (key === "index" && !host.index) {
        this.denyHost(principal, "host index is not bound", ["index"], name);
      }
      if (key === "tenant" && !host.tenant) {
        this.denyHost(principal, "host tenant is not bound", ["tenant"], name);
      }
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
    if (chp.state === "REJECTED") {
      throw Object.assign(new Error(chp.rationale), {
        rpc: { code: -32003, message: chp.rationale, data: chp },
      });
    }
    if (chp.state !== "LOCKED" && name === "stripe.charge") {
      throw Object.assign(new Error("CHP requires human lock before this tool"), {
        rpc: { code: -32004, message: "pending_human", data: chp },
      });
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
        throw Object.assign(new Error("spend plane blocked"), {
          rpc: { code: -32005, message: "blocked by spend plane", data: hooked.json },
        });
      }
    }

    const impl = this.tools.get(name);
    if (!impl) throw new Error(`unknown tool ${name}`);
    const result = impl(args, principal, host);
    this.ledger.append({
      event: "tool.called",
      actor: principal.id,
      inputs: { name, amountCents },
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
        const principal = this.resolvePrincipal(req);
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const sse = openSse(res);
        this.seq += 1;
        const frame = {
          jsonrpc: "2.0",
          method: "notifications/message",
          params: {
            level: "info",
            message: "sse-open",
            _meta: { cubiczan: { principal } },
          },
        };
        sse.send("message", frame, String(this.seq));
        if (url.searchParams.get("once") === "1") sse.close();
        return;
      }

      const obj = asObject(body);

      if (req.method === "GET" && url.pathname === "/v1/context/tax") {
        const principal = this.resolvePrincipal(req);
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const sessionId = url.searchParams.get("session") ?? undefined;
        try {
          sendJson(res, 200, this.contextTaxReport(principal, sessionId));
        } catch (error) {
          const mismatch = error && typeof error === "object" && "code" in error && (error as { code: string }).code === "session_mismatch";
          sendJson(res, mismatch ? 409 : 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/context/packs") {
        const principal = this.resolvePrincipal(req);
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
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
        const principal = this.resolvePrincipal(req);
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const sessionId = this.sessionIdFor(principal, obj, req);
        try {
          sendJson(res, 200, this.admitNeed(principal, sessionId, {
            tools: asStringArray(obj.tools),
            pack: typeof obj.pack === "string" ? obj.pack : undefined,
          }));
        } catch (error) {
          const mismatch = error && typeof error === "object" && "code" in error && (error as { code: string }).code === "session_mismatch";
          sendJson(res, mismatch ? 409 : 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/credentials") {
        const principal = this.resolvePrincipal(req);
        if (!principal || principal.kind === "agent") {
          sendJson(res, 401, { error: "operator required" });
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
        const principal = this.resolvePrincipal(req);
        if (!principal || principal.kind === "agent") {
          sendJson(res, 401, { error: "operator required" });
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
        const principal = this.resolvePrincipal(req);
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const method = String(obj.method ?? "");
        const id = obj.id ?? null;
        if (method === "initialize") {
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
          try {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              result: this.listTools(principal, asObject(obj.params), req),
            });
          } catch (error) {
            const rpc = (error as { rpc?: { code: number; message: string; data?: unknown } }).rpc;
            const mismatch = error && typeof error === "object" && "code" in error && (error as { code: string }).code === "session_mismatch";
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              error:
                rpc ??
                (mismatch
                  ? { code: -32007, message: error instanceof Error ? error.message : "session mismatch" }
                  : { code: -32000, message: error instanceof Error ? error.message : String(error) }),
            });
          }
          return;
        }
        if (method === "tools/call") {
          const paramsIn = asObject(obj.params);
          const claimed = asObject(asObject(asObject(paramsIn._meta).cubiczan).principal);
          const impersonation = claimedPrincipalConflict(principal, claimed);
          if (impersonation) {
            try {
              this.denyHost(principal, impersonation, ["principal"], String(paramsIn.name ?? ""));
            } catch (error) {
              const rpc = (error as { rpc?: { code: number; message: string; data?: unknown } }).rpc;
              sendJson(res, 200, {
                jsonrpc: "2.0",
                id,
                error: rpc ?? { code: -32006, message: impersonation },
              });
              return;
            }
          }
          const hostBound = this.hostBindingsFor(principal, paramsIn, req);
          if (!hostBound.ok) {
            try {
              this.denyHost(principal, hostBound.reason, hostBound.invented, String(paramsIn.name ?? ""));
            } catch (error) {
              const rpc = (error as { rpc?: { code: number; message: string; data?: unknown } }).rpc;
              sendJson(res, 200, {
                jsonrpc: "2.0",
                id,
                error: rpc ?? { code: -32006, message: hostBound.reason },
              });
              return;
            }
          }
          const attached = this.attachPrincipal(obj, principal, hostBound.host);
          const params = asObject(attached.params);
          const name = String(params.name ?? "");
          const args = asObject(params.arguments);
          try {
            const result = await this.dispatchTool(principal, name, args, hostBound.host);
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
                _meta: { cubiczan: { principal, host: hostBound.host } },
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
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown method ${method}` },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/locks") {
        const principal = this.resolvePrincipal(req);
        if (!principal || principal.kind === "agent") {
          sendJson(res, 401, { error: "human required" });
          return;
        }
        const decision = obj.decision === "reject" ? "reject" : "approve";
        sendJson(res, 200, applyHumanLock(decision, String(obj.notes ?? "")));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    });
  }
}
