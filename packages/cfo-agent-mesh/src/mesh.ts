import {
  AuditLedger,
  bearer,
  createServer,
  isoNow,
  newId,
  sendJson,
  type ChpState,
  type Json,
  type Principal,
} from "@cubiczan/shared";
import { createHash } from "node:crypto";
import type http from "node:http";
import { levelPayments, rollforward, type LeaseResult } from "./engines/lease.ts";
import { measure, type Measurement } from "./engines/revenue.ts";
import { periodExpense, type PeriodExpense } from "./engines/sbc.ts";

export interface DocumentRef {
  id: string;
  name: string;
  sha256: string;
}

export interface TokenEvent {
  id: string;
  claimId: string;
  model: string;
  tokens: number;
  amountCents: number;
  at: string;
}

export interface Claim {
  id: string;
  title: string;
  narrative: string;
  agentId: string;
  lockState: ChpState;
  documents: DocumentRef[];
  engineOutputs: Array<{ kind: "lease" | "revenue" | "sbc"; payload: unknown }>;
  tokenEvents: string[];
  createdAt: string;
}

function asObject(value: Json | undefined): Record<string, Json> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class CfoMesh {
  readonly ledger: AuditLedger;
  readonly claims = new Map<string, Claim>();
  readonly tokens: TokenEvent[] = [];
  readonly keys = new Map<string, Principal>();

  constructor(auditKey = "cfo-demo-key") {
    this.ledger = new AuditLedger(auditKey);
  }

  seedDemo(): { agentKey: string; humanKey: string } {
    const agentKey = process.env.CFO_AGENT_KEY ?? "cfo_agt_lease_demo";
    const humanKey = process.env.CFO_HUMAN_KEY ?? "cfo_human_controller_demo";
    this.keys.set(hashKey(agentKey), {
      id: "agt_lease",
      kind: "agent",
      orgId: "org_acme",
      displayName: "Lease Engine Agent",
    });
    this.keys.set(hashKey(humanKey), {
      id: "human.controller",
      kind: "human",
      orgId: "org_acme",
      displayName: "Controller",
    });
    return { agentKey, humanKey };
  }

  resolve(req: http.IncomingMessage): Principal | undefined {
    const token = bearer(req);
    if (!token) return undefined;
    return this.keys.get(hashKey(token));
  }

  createClaim(input: { title: string; narrative: string; agentId: string }): Claim {
    const claim: Claim = {
      id: newId("clm"),
      title: input.title,
      narrative: input.narrative,
      agentId: input.agentId,
      lockState: "EXPLORING",
      documents: [],
      engineOutputs: [],
      tokenEvents: [],
      createdAt: isoNow(),
    };
    this.claims.set(claim.id, claim);
    this.ledger.append({
      event: "claim.opened",
      actor: input.agentId,
      inputs: { claimId: claim.id, title: claim.title },
      sources: ["mesh"],
    });
    return claim;
  }

  addDocument(claimId: string, name: string, content: string): DocumentRef {
    const claim = this.require(claimId);
    const doc: DocumentRef = {
      id: newId("doc"),
      name,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    claim.documents.push(doc);
    this.ledger.append({
      event: "document.attached",
      actor: claim.agentId,
      inputs: { claimId, documentId: doc.id, sha256: doc.sha256 },
      sources: [doc.sha256],
    });
    return doc;
  }

  lock(claimId: string, actor: Principal, state: ChpState = "LOCKED"): Claim {
    if (actor.kind === "agent") throw new Error("human lock required");
    const claim = this.require(claimId);
    claim.lockState = state;
    this.ledger.append({
      event: "claim.locked",
      actor: actor.id,
      inputs: { claimId, state },
      sources: ["chp", "human"],
    });
    return claim;
  }

  recordTokens(claimId: string, model: string, tokens: number, amountCents: number): TokenEvent {
    const claim = this.require(claimId);
    const event: TokenEvent = {
      id: newId("tok"),
      claimId,
      model,
      tokens,
      amountCents,
      at: isoNow(),
    };
    this.tokens.push(event);
    claim.tokenEvents.push(event.id);
    this.ledger.append({
      event: "tokens.recorded",
      actor: claim.agentId,
      inputs: { claimId, model, tokens, amountCents },
      sources: ["agent-observability", event.id],
    });
    return event;
  }

  attachLease(claimId: string, result: LeaseResult): void {
    this.require(claimId).engineOutputs.push({ kind: "lease", payload: result });
  }

  attachRevenue(claimId: string, result: Measurement): void {
    this.require(claimId).engineOutputs.push({ kind: "revenue", payload: result });
  }

  attachSbc(claimId: string, result: PeriodExpense): void {
    this.require(claimId).engineOutputs.push({ kind: "sbc", payload: result });
  }

  seal(claimId: string): Record<string, unknown> {
    const claim = this.require(claimId);
    if (claim.lockState !== "LOCKED") throw new Error("claim is not LOCKED");
    if (claim.documents.length === 0) throw new Error("claim has no source documents");
    const tokenSources = this.tokens.filter((t) => t.claimId === claimId);
    const pack = {
      controlId: "ICFR-CFO-MESH-01",
      claimId: claim.id,
      title: claim.title,
      narrative: claim.narrative,
      agentId: claim.agentId,
      lockState: claim.lockState,
      documents: claim.documents,
      engines: claim.engineOutputs,
      tokenSources,
      sealedAt: isoNow(),
    };
    const record = this.ledger.append({
      event: "evidence.sealed",
      actor: claim.agentId,
      inputs: pack,
      sources: [
        claim.agentId,
        claim.lockState,
        ...claim.documents.map((d) => d.sha256),
        ...tokenSources.map((t) => t.id),
      ],
      confidence: "high",
      rationale: "Every board claim traces to an agent, a lock, and a document.",
    });
    const verify = this.ledger.verify();
    if (!verify.ok) throw new Error("ledger verify failed");
    return { pack, sig: record.sig, prevSig: record.prevSig, ledgerOk: verify.ok };
  }

  private require(id: string): Claim {
    const claim = this.claims.get(id);
    if (!claim) throw new Error("claim not found");
    return claim;
  }

  createHttpServer(): http.Server {
    return createServer(async (req, res, url, body) => {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "cfo-agent-mesh" });
        return;
      }
      const obj = asObject(body);
      const principal = this.resolve(req);

      if (req.method === "POST" && url.pathname === "/v1/claims") {
        const agentId = String(obj.agentId ?? principal?.id ?? "");
        sendJson(
          res,
          200,
          this.createClaim({
            title: String(obj.title ?? "untitled"),
            narrative: String(obj.narrative ?? ""),
            agentId,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/documents")) {
        const claimId = url.pathname.split("/")[3];
        sendJson(
          res,
          200,
          this.addDocument(claimId, String(obj.name ?? "source.txt"), String(obj.content ?? "")),
        );
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/lock")) {
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        try {
          sendJson(res, 200, this.lock(url.pathname.split("/")[3], principal));
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/tokens")) {
        const claimId = url.pathname.split("/")[3];
        sendJson(
          res,
          200,
          this.recordTokens(
            claimId,
            String(obj.model ?? "unknown"),
            Number(obj.tokens ?? 0),
            Number(obj.amountCents ?? 0),
          ),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/engines/lease") {
        const periods = Number(obj.periods ?? 24);
        const amount = Number(obj.amount ?? 1000);
        const result = rollforward({
          leaseId: String(obj.leaseId ?? "L-1"),
          description: String(obj.description ?? "lease"),
          payments: levelPayments(amount, periods),
          annualIbr: Number(obj.annualIbr ?? 0.05),
          transfersOwnership: Boolean(obj.transfersOwnership ?? true),
        });
        if (obj.claimId) this.attachLease(String(obj.claimId), result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/engines/revenue") {
        const result = measure({
          contractId: String(obj.contractId ?? "C-1"),
          description: String(obj.description ?? "contract"),
          timing: (obj.timing as "over_time" | "point_in_time") ?? "over_time",
          transactionPrice: Number(obj.transactionPrice ?? 100),
          constrainedPrice: Number(obj.constrainedPrice ?? 80),
          estimatedTotalCost: Number(obj.estimatedTotalCost ?? 100),
          costsIncurredToDate: Number(obj.costsIncurredToDate ?? 40),
          billingsToDate: Number(obj.billingsToDate ?? 0),
        });
        if (obj.claimId) this.attachRevenue(String(obj.claimId), result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/engines/sbc") {
        const result = periodExpense(
          {
            grantId: String(obj.grantId ?? "G-1"),
            awardType: "rsu",
            grantDate: String(obj.grantDate ?? "2025-01-01"),
            shares: Number(obj.shares ?? 1000),
            serviceYears: Number(obj.serviceYears ?? 4),
            grantDateFv: Number(obj.grantDateFv ?? 10),
          },
          String(obj.periodStart ?? "2025-01-01"),
          String(obj.periodEnd ?? "2025-12-31"),
        );
        if (obj.claimId) this.attachSbc(String(obj.claimId), result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/evidence/")) {
        try {
          sendJson(res, 200, this.seal(url.pathname.split("/")[3]));
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    });
  }
}
