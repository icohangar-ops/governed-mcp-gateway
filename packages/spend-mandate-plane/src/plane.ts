import {
  AuditLedger,
  applyHumanLock,
  bearer,
  cents,
  createServer,
  isoNow,
  newId,
  runChpGate,
  sendJson,
  type ChpState,
  type Principal,
} from "@cubiczan/shared";
import type http from "node:http";
import type { Json } from "@cubiczan/shared";

export type Lane = "auto" | "approval" | "blocked";
export type Rail = "stripe" | "x402";

export interface Merchant {
  name: string;
  url: string;
  country: string;
}

export interface Mandate {
  id: string;
  agent: string;
  merchantUrl: string | "any";
  remainingCents: number;
  currency: string;
  validUntil: string;
}

export interface AgentPolicy {
  principal: Principal;
  apiKeyHash: string;
  autoExecuteCapCents: number;
  spendCapCents: number;
  spendUsedCents: number;
  allowedMerchants: string[] | "any";
}

export interface Proposal {
  id: string;
  agent: string;
  kind: "purchase" | "renewal" | "topup";
  merchant: Merchant;
  totalCents: number;
  currency: string;
  rationale: string;
  lane: Lane;
  chpState: ChpState;
  mandateId: string | null;
  countersignedBy?: string;
  settled?: { rail: Rail; reference: string; at: string };
  reasons: string[];
  createdAt: string;
}

function asObject(value: Json | undefined): Record<string, Json> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function hashKey(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export class SpendPlane {
  readonly ledger: AuditLedger;
  readonly policies = new Map<string, AgentPolicy>();
  readonly keys = new Map<string, string>();
  readonly mandates: Mandate[] = [];
  readonly proposals: Proposal[] = [];
  readonly meter: Array<{ clearanceId: string; amountCents: number; rail: Rail }> = [];

  constructor(auditKey = "spend-demo-key") {
    this.ledger = new AuditLedger(auditKey);
  }

  seedDemo(): { agentKey: string; humanKey: string } {
    const agentKey = process.env.SPEND_AGENT_KEY ?? "spend_agt_payops_demo";
    const humanKey = process.env.SPEND_HUMAN_KEY ?? "spend_human_controller_demo";
    this.register(
      {
        id: "agt_payops",
        kind: "agent",
        orgId: "org_acme",
        displayName: "PayOps Runner",
      },
      agentKey,
      5000,
      50_000,
      ["stripe.com", "openai.com"],
    );
    this.register(
      {
        id: "human.controller",
        kind: "human",
        orgId: "org_acme",
        displayName: "Controller",
      },
      humanKey,
      0,
      0,
      "any",
    );
    this.mandates.push({
      id: "man_stripe_monthly",
      agent: "agt_payops",
      merchantUrl: "https://stripe.com",
      remainingCents: 20_000,
      currency: "USD",
      validUntil: "2027-12-31T00:00:00.000Z",
    });
    return { agentKey, humanKey };
  }

  register(
    principal: Principal,
    apiKey: string,
    autoExecuteCapCents: number,
    spendCapCents: number,
    allowedMerchants: string[] | "any",
  ): void {
    const hashed = hashKey(apiKey);
    this.keys.set(hashed, principal.id);
    this.policies.set(principal.id, {
      principal,
      apiKeyHash: hashed,
      autoExecuteCapCents,
      spendCapCents,
      spendUsedCents: 0,
      allowedMerchants,
    });
  }

  resolve(req: http.IncomingMessage): Principal | undefined {
    const token = bearer(req);
    if (!token) return undefined;
    const id = this.keys.get(hashKey(token));
    if (!id) return undefined;
    return this.policies.get(id)?.principal;
  }

  propose(input: {
    agent: string;
    kind?: Proposal["kind"];
    merchant: Merchant;
    total: string;
    currency?: string;
    rationale: string;
  }): Proposal {
    const policy = this.policies.get(input.agent);
    if (!policy) throw new Error("unknown agent");
    const totalCents = cents(input.total);
    const host = new URL(input.merchant.url).hostname.replace(/^www\./, "");
    const merchantOk =
      policy.allowedMerchants === "any" ||
      policy.allowedMerchants.some((m) => host === m || host.endsWith(`.${m}`));
    const mandate = this.mandates.find(
      (m) =>
        m.agent === input.agent &&
        (m.merchantUrl === "any" || new URL(m.merchantUrl).hostname.replace(/^www\./, "") === host) &&
        m.remainingCents >= totalCents &&
        new Date(m.validUntil).getTime() >= Date.now(),
    );
    const reasons: string[] = [];
    if (!merchantOk) reasons.push("merchant_not_allowed");
    if (!mandate) reasons.push("no_mandate_match");
    if (totalCents > policy.spendCapCents - policy.spendUsedCents) reasons.push("over_spend_cap");

    const chp = runChpGate({
      action: `spend.${input.kind ?? "purchase"}`,
      amountCents: totalCents,
      principal: policy.principal,
      policyMaxAutoCents: policy.autoExecuteCapCents,
      spendCapCents: policy.spendCapCents,
      spendUsedCents: policy.spendUsedCents,
      allowed: merchantOk,
      blocked: !merchantOk,
      scoped: Boolean(input.merchant.url),
    });

    let lane: Lane = "blocked";
    if (chp.state === "LOCKED" && mandate) lane = "auto";
    else if (chp.state === "PROVISIONAL" || chp.state === "PROVISIONAL_LOCK") lane = "approval";
    else if (chp.state === "REJECTED") lane = "blocked";
    else if (mandate && totalCents > policy.autoExecuteCapCents) lane = "approval";

    const proposal: Proposal = {
      id: newId("prp"),
      agent: input.agent,
      kind: input.kind ?? "purchase",
      merchant: input.merchant,
      totalCents,
      currency: input.currency ?? "USD",
      rationale: input.rationale,
      lane,
      chpState: chp.state,
      mandateId: mandate?.id ?? null,
      reasons: [...reasons, ...chp.attackFindings],
      createdAt: isoNow(),
    };
    this.proposals.unshift(proposal);
    this.ledger.append({
      event: "proposal.routed",
      actor: input.agent,
      inputs: { id: proposal.id, lane, totalCents },
      sources: ["policy", "mandate", "chp"],
      rationale: chp.rationale,
    });
    return proposal;
  }

  countersign(proposalId: string, principal: Principal, notes?: string): Proposal {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (principal.id === proposal.agent) throw new Error("agent cannot countersign itself");
    if (principal.kind !== "human") throw new Error("countersign requires a human key");
    if (proposal.lane === "blocked") throw new Error("blocked proposals cannot be countersigned");
    const outcome = applyHumanLock("approve", notes);
    proposal.lane = "auto";
    proposal.chpState = outcome.state;
    proposal.countersignedBy = principal.id;
    this.ledger.append({
      event: "proposal.countersigned",
      actor: principal.id,
      inputs: { proposalId },
      sources: ["human", "chp"],
      rationale: outcome.rationale,
    });
    return proposal;
  }

  settle(proposalId: string, rail: Rail = "stripe"): Proposal {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.chpState !== "LOCKED" || proposal.lane !== "auto") {
      throw new Error("proposal is not locked for settlement");
    }
    const policy = this.policies.get(proposal.agent);
    if (!policy) throw new Error("unknown agent");
    policy.spendUsedCents += proposal.totalCents;
    const mandate = this.mandates.find((m) => m.id === proposal.mandateId);
    if (mandate) mandate.remainingCents -= proposal.totalCents;

    const reference =
      rail === "stripe"
        ? `evt_meter_${proposal.id}`
        : `x402_payreq_${proposal.id}`;
    proposal.settled = { rail, reference, at: isoNow() };
    this.meter.push({ clearanceId: proposal.id, amountCents: proposal.totalCents, rail });
    this.ledger.append({
      event: rail === "stripe" ? "rail.stripe.metered" : "rail.x402.payment_required",
      actor: proposal.agent,
      inputs: { proposalId, rail, reference, amountCents: proposal.totalCents },
      sources: [rail],
    });
    return proposal;
  }

  createHttpServer(): http.Server {
    return createServer(async (req, res, url, body) => {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "spend-mandate-plane" });
        return;
      }
      const obj = asObject(body);
      const principal = this.resolve(req);

      if (req.method === "POST" && url.pathname === "/v1/mandates") {
        if (!principal || principal.kind === "agent") {
          sendJson(res, 401, { error: "operator required" });
          return;
        }
        const mandate: Mandate = {
          id: newId("man"),
          agent: String(obj.agent),
          merchantUrl: (obj.merchantUrl as string) ?? "any",
          remainingCents: Number(obj.remainingCents ?? 0),
          currency: String(obj.currency ?? "USD"),
          validUntil: String(obj.validUntil ?? "2027-12-31T00:00:00.000Z"),
        };
        this.mandates.push(mandate);
        sendJson(res, 200, mandate);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/proposals") {
        try {
          const agent = String(obj.agent ?? principal?.id ?? "");
          const merchant = asObject(obj.merchant);
          const proposal = this.propose({
            agent,
            kind: (obj.kind as Proposal["kind"]) ?? "purchase",
            merchant: {
              name: String(merchant.name ?? "unknown"),
              url: String(merchant.url ?? "https://example.com"),
              country: String(merchant.country ?? "US"),
            },
            total: String(obj.total ?? "0"),
            currency: String(obj.currency ?? "USD"),
            rationale: String(obj.rationale ?? ""),
          });
          sendJson(res, 200, proposal);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/countersign") {
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        try {
          sendJson(
            res,
            200,
            this.countersign(String(obj.proposalId), principal, String(obj.notes ?? "")),
          );
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/settle") {
        try {
          sendJson(res, 200, this.settle(String(obj.proposalId), (obj.rail as Rail) ?? "stripe"));
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    });
  }
}
