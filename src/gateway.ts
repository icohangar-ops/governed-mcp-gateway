import { createHash } from "node:crypto";
import {
  AuditLedger,
  applyHumanLock,
  bearer,
  createServer,
  newId,
  openSse,
  postJson,
  runChpGate,
  sendJson,
  type Principal,
  type Json,
} from "./shared/index.js";
import type http from "node:http";

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

export class GovernedGateway {
  readonly ledger: AuditLedger;
  readonly credentials = new Map<string, Credential>();
  readonly agents = new Map<string, AgentRecord>();
  readonly keys = new Map<string, string>();
  readonly tools = new Map<string, (args: Record<string, Json>, principal: Principal) => Json>();
  private seq = 0;

  constructor(private readonly options: GatewayOptions = {}) {
    this.ledger = new AuditLedger(options.auditKey ?? "gateway-demo-key");
    this.tools.set("echo.ping", (args, principal) => ({
      pong: true,
      echo: args,
      principal: principal as unknown as Json,
    }));
    this.tools.set("stripe.charge", (args, principal) => ({
      simulated: true,
      amountCents: args.amountCents ?? 0,
      principal: principal as unknown as Json,
    }));
    this.tools.set("search.web", (args, principal) => ({
      hits: [],
      query: args.query ?? "",
      principal: principal as unknown as Json,
    }));
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

  attachPrincipal(payload: Record<string, Json>, principal: Principal): Record<string, Json> {
    const params = asObject(payload.params);
    const meta = asObject(params._meta);
    const cubiczan = asObject(meta.cubiczan);
    cubiczan.principal = principal as unknown as Json;
    meta.cubiczan = cubiczan;
    params._meta = meta;
    return { ...payload, params };
  }

  async dispatchTool(principal: Principal, name: string, args: Record<string, Json>): Promise<Json> {
    const agent = this.agents.get(principal.id);
    if (!agent) throw new Error("unknown principal");
    if (!agent.allowlist.includes(name)) {
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
          const agent = this.agents.get(principal.id);
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              tools: (agent?.allowlist ?? []).map((name) => ({
                name,
                description: `Governed tool ${name}`,
                inputSchema: { type: "object" },
              })),
            },
          });
          return;
        }
        if (method === "tools/call") {
          const attached = this.attachPrincipal(obj, principal);
          const params = asObject(attached.params);
          const name = String(params.name ?? "");
          const args = asObject(params.arguments);
          try {
            const result = await this.dispatchTool(principal, name, args);
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
                _meta: { cubiczan: { principal } },
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
