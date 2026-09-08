import { createHash } from "node:crypto";
import {
  AuditLedger,
  applyHumanLock,
  bearer,
  bearerFromAuthorization,
  createServer,
  incomingToRequest,
  isoNow,
  newId,
  openSse,
  postJson,
  runChpGate,
  sendJson,
  sendWebResponse,
  type Principal,
} from "@cubiczan/shared";
import type http from "node:http";
import type { Json } from "@cubiczan/shared";
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
  defaultClaimAllowlist,
  toolsForScopes,
  type ClaimAllowlistSeed,
} from "./claim-allowlist.ts";
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
  claimFixture?: ClaimAllowlistSeed;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Json;
  result?: unknown;
  error?: JsonRpcError;
}

export const MCP_INSTRUCTIONS =
  "Governed MCP Gateway. Every tools/call carries params._meta.cubiczan.principal from the authenticated credential. Default tools/list is the session pack (echo.ping plus catalog meta-tools context.inspect and context.need), not the full allowlist. Call context.inspect to read schema token tax; call context.need to admit allowlisted tools (pack=payments for stripe.charge). Disallowed tools return JSON-RPC -32001 and do not run. Stdio uses the seeded PayOps demo principal unless GATEWAY_AGENT_KEY is set.";

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

export type GatewayRequest = http.IncomingMessage | Request;

function headerSession(req?: GatewayRequest): string {
  if (!req) return "";
  if (req instanceof Request) return req.headers.get("x-cubiczan-session") ?? "";
  const raw = req.headers["x-cubiczan-session"];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/api" || pathname === "/";
}

function isHealthPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/healthz";
}

function delegatedWebPath(method: string, pathname: string): boolean {
  if (isHealthPath(pathname)) return true;
  if (pathname === "/mcp" || pathname === "/api") return true;
  if (pathname === "/" && (method === "POST" || method === "OPTIONS")) return true;
  return false;
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Cubiczan-Session",
    "access-control-expose-headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
      ...extra,
    },
  });
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
  readonly claims: ClaimAllowlistSeed;
  private seq = 0;

  constructor(private readonly options: GatewayOptions = {}) {
    this.ledger = new AuditLedger(options.auditKey ?? "gateway-demo-key");
    this.thresholds = { ...DEFAULT_TAX_THRESHOLDS, ...options.taxThresholds };
    this.claims = options.claimFixture ?? defaultClaimAllowlist();
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

    const map = this.claims.mappings;
    this.registerAgent(
      {
        id: "agt_payops",
        kind: "agent",
        orgId: "org_acme",
        displayName: "PayOps Runner",
      },
      agentKey,
      toolsForScopes(["tools:echo", "tools:payments"], map),
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
      toolsForScopes(["tools:echo", "tools:search"], map),
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
      toolsForScopes(["tools:echo"], map),
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
    return this.principalForToken(bearer(req));
  }

  principalForToken(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const id = this.keys.get(hash(token));
    if (!id) return undefined;
    return this.agents.get(id)?.principal;
  }

  stdioPrincipal(): Principal {
    const token = process.env.GATEWAY_AGENT_KEY ?? "mcp_agt_payops_demo";
    const principal = this.principalForToken(token);
    if (!principal) throw new Error("stdio principal is not seeded; call seedDemo() first");
    return principal;
  }

  attachPrincipal(payload: Record<string, Json>, principal: Principal): Record<string, Json> {
    const params = asObject(payload.params);
    const meta = asObject(params._meta);
    const cubiczan = asObject(meta.cubiczan);
    cubiczan.principal = principal as unknown as Json;
    meta.cubiczan = cubiczan;
    params._meta = meta;
    return { ...payload, params };
  }

  sessionIdFor(principal: Principal, params: Record<string, Json>, req?: GatewayRequest): string {
    const meta = asObject(asObject(params._meta).cubiczan);
    return resolveSessionId(
      principal.id,
      typeof params.sessionId === "string" ? params.sessionId : undefined,
      headerSession(req),
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

  listTools(principal: Principal, params: Record<string, Json>, req?: GatewayRequest): {
    tools: Array<{ name: string; description: string; inputSchema: Json }>;
    _meta: { cubiczan: { principal: Principal; sessionId: string; tax: ListTax } };
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

    return {
      tools: listed,
      _meta: { cubiczan: { principal, sessionId, tax } },
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

  async dispatchTool(principal: Principal, name: string, args: Record<string, Json>): Promise<Json> {
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
    const result = impl(args, principal);
    this.ledger.append({
      event: "tool.called",
      actor: principal.id,
      inputs: { name, amountCents },
      sources: ["mcp", "chp"],
      rationale: chp.rationale,
    });
    return result;
  }

  initializeResult(): Record<string, Json> {
    return {
      protocolVersion: "2025-03-26",
      serverInfo: {
        name: "governed-mcp-gateway",
        version: "0.1.0",
        title: "Governed MCP Gateway",
        websiteUrl: "https://github.com/Cubiczan/governed-mcp-gateway",
      },
      capabilities: { tools: { listChanged: false }, logging: {} },
      instructions: MCP_INSTRUCTIONS,
    };
  }

  healthPayload(): Record<string, Json> {
    return {
      ok: true,
      service: "governed-mcp-gateway",
      transport: "streamable-http",
      mode: "stateless",
    };
  }

  async handleWebRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if ((request.method === "GET" || request.method === "HEAD") && isHealthPath(pathname)) {
      const payload = JSON.stringify(this.healthPayload());
      return new Response(request.method === "HEAD" ? null : payload, {
        status: 200,
        headers: {
          ...cors,
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(payload)),
        },
      });
    }

    if (!isMcpPath(pathname)) {
      return jsonResponse(404, { error: "not found" }, cors);
    }

    const principal = this.principalForToken(bearerFromAuthorization(request.headers.get("authorization")));
    if (!principal) {
      return jsonResponse(401, { error: "unauthorized" }, {
        ...cors,
        "www-authenticate": 'Bearer realm="governed-mcp-gateway", error="invalid_token"',
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        405,
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } },
        cors,
      );
    }

    let obj: Record<string, Json> = {};
    try {
      const text = await request.text();
      if (text.trim()) obj = asObject(JSON.parse(text) as Json);
    } catch {
      return jsonResponse(400, { error: "invalid json" }, cors);
    }

    const rpc = await this.handleJsonRpc(principal, obj, request);
    return jsonResponse(200, rpc ?? { jsonrpc: "2.0", id: null, result: {} }, {
      ...cors,
      "mcp-protocol-version": "2025-03-26",
    });
  }

  async handleJsonRpc(
    principal: Principal,
    obj: Record<string, Json>,
    req?: GatewayRequest,
  ): Promise<JsonRpcResponse | undefined> {
    const method = String(obj.method ?? "");
    const id = (Object.prototype.hasOwnProperty.call(obj, "id") ? obj.id : null) ?? null;
    if (method.startsWith("notifications/")) return undefined;

    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: this.initializeResult() };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: this.listTools(principal, asObject(obj.params), req) };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    if (method === "tools/call") {
      const attached = this.attachPrincipal(obj, principal);
      const params = asObject(attached.params);
      const name = String(params.name ?? "");
      const args = asObject(params.arguments);
      try {
        const result = await this.dispatchTool(principal, name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            _meta: { cubiczan: { principal } },
            structuredContent: result,
          },
        };
      } catch (error) {
        const rpc = (error as { rpc?: JsonRpcError }).rpc;
        return {
          jsonrpc: "2.0",
          id,
          error: rpc ?? { code: -32000, message: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
  }

  createHttpServer(): http.Server {
    return createServer(async (req, res, url, body) => {
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

      const path = normalizePath(url.pathname);
      if (delegatedWebPath(req.method ?? "GET", path)) {
        const webRes = await this.handleWebRequest(incomingToRequest(req, url, body));
        await sendWebResponse(res, webRes);
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
        sendJson(res, 200, this.contextTaxReport(principal, sessionId));
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
        sendJson(res, 200, this.admitNeed(principal, sessionId, {
          tools: asStringArray(obj.tools),
          pack: typeof obj.pack === "string" ? obj.pack : undefined,
        }));
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

export function createSeededGateway(options: GatewayOptions = {}): GovernedGateway {
  const gateway = new GovernedGateway({
    spendPlaneUrl: process.env.SPEND_PLANE_URL,
    ...options,
  });
  gateway.seedDemo();
  return gateway;
}
