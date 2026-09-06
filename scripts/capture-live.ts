import { listen } from "../packages/shared/src/index.ts";
import { GovernedGateway } from "../packages/governed-mcp-gateway/src/gateway.ts";
import { SpendPlane } from "../packages/spend-mandate-plane/src/plane.ts";
import { CfoMesh } from "../packages/cfo-agent-mesh/src/mesh.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outFile = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screenshots/live-captures.json");

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) next[key] = obj[key];
  }
  return next;
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const gateway = new GovernedGateway();
  const spend = new SpendPlane();
  const cfo = new CfoMesh();
  const gKeys = gateway.seedDemo();
  const sKeys = spend.seedDemo();
  const cKeys = cfo.seedDemo();
  const gServer = gateway.createHttpServer();
  const sServer = spend.createHttpServer();
  const cServer = cfo.createHttpServer();
  const gPort = await listen(gServer, 0);
  const sPort = await listen(sServer, 0);
  const cPort = await listen(cServer, 0);
  const g = `http://127.0.0.1:${gPort}`;
  const s = `http://127.0.0.1:${sPort}`;
  const c = `http://127.0.0.1:${cPort}`;

  try {
    const callRes = await fetch(`${g}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gKeys.agentKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo.ping", arguments: { hello: "world" } },
      }),
    });
    const callJson = await json(callRes);
    const result = (callJson.result ?? {}) as Record<string, unknown>;
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const gateway_call = {
      jsonrpc: callJson.jsonrpc,
      method: "tools/call",
      result: {
        _meta: result._meta,
        structuredContent: {
          pong: structured.pong,
          echo: structured.echo,
          principal: structured.principal,
        },
      },
    };

    const sseRes = await fetch(`${g}/mcp/sse?once=1`, {
      headers: { authorization: `Bearer ${gKeys.agentKey}` },
    });
    const sseText = (await sseRes.text()).trim();
    const dataLine = sseText.split("\n").find((line) => line.startsWith("data: "));
    let gateway_sse = sseText;
    if (dataLine) {
      try {
        const parsed = JSON.parse(dataLine.slice(6));
        gateway_sse = `id: 1\nevent: message\ndata: ${JSON.stringify(parsed, null, 2)}`;
      } catch {
        gateway_sse = sseText;
      }
    }

    const rotateRes = await fetch(`${g}/v1/credentials/github_token/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gKeys.humanKey}`,
      },
      body: JSON.stringify({ secret: "ghp_new_secret_bbbb" }),
    });
    const rotateJson = await json(rotateRes);
    const oldOk = gateway.verifyCredential("github_token", "ghp_old_secret_aaaa");
    const newOk = gateway.verifyCredential("github_token", "ghp_new_secret_bbbb");
    const gateway_rotate = {
      name: rotateJson.name,
      version: rotateJson.version,
      preview: rotateJson.preview,
      oldSecretValid: oldOk,
      newSecretValid: newOk,
      inputIdUnchanged: rotateJson.name === "github_token",
    };

    const autoRes = await fetch(`${s}/v1/proposals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sKeys.agentKey}`,
      },
      body: JSON.stringify({
        agent: "agt_payops",
        merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
        total: "12.00",
        rationale: "metered tool call",
      }),
    });
    const autoJson = await json(autoRes);
    const spend_auto = pick(autoJson, [
      "id",
      "agent",
      "totalCents",
      "currency",
      "lane",
      "chpState",
      "mandateId",
      "reasons",
    ]);

    const overRes = await fetch(`${s}/v1/proposals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sKeys.agentKey}`,
      },
      body: JSON.stringify({
        agent: "agt_payops",
        merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
        total: "80.00",
        rationale: "large vendor payment",
      }),
    });
    const overJson = await json(overRes);
    const agentSign = await fetch(`${s}/v1/countersign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sKeys.agentKey}`,
      },
      body: JSON.stringify({ proposalId: overJson.id }),
    });
    const agentSignJson = await json(agentSign);
    const humanSign = await fetch(`${s}/v1/countersign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sKeys.humanKey}`,
      },
      body: JSON.stringify({ proposalId: overJson.id, notes: "approved for vendor" }),
    });
    const humanSignJson = await json(humanSign);
    const spend_countersign = {
      proposal: pick(overJson, ["id", "totalCents", "lane", "chpState"]),
      agentCountersign: { status: agentSign.status, ...agentSignJson },
      humanCountersign: pick(humanSignJson, ["id", "lane", "chpState", "countersignedBy"]),
    };

    const settleStripe = await fetch(`${s}/v1/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: autoJson.id, rail: "stripe" }),
    });
    const settleStripeJson = await json(settleStripe);
    const x402Res = await fetch(`${s}/v1/proposals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sKeys.agentKey}`,
      },
      body: JSON.stringify({
        agent: "agt_payops",
        merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
        total: "5.00",
        rationale: "x402 rail demo",
      }),
    });
    const x402Prop = await json(x402Res);
    const settleX402 = await fetch(`${s}/v1/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: x402Prop.id, rail: "x402" }),
    });
    const settleX402Json = await json(settleX402);
    const spend_settle = {
      stripe: (settleStripeJson.settled as Record<string, unknown>) ?? settleStripeJson,
      x402: (settleX402Json.settled as Record<string, unknown>) ?? settleX402Json,
    };

    const unsealedClaim = await json(
      await fetch(`${c}/v1/claims`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cKeys.agentKey}`,
        },
        body: JSON.stringify({
          title: "ROU increased",
          narrative: "Lease population grew",
          agentId: "agt_lease",
        }),
      }),
    );
    await fetch(`${c}/v1/claims/${unsealedClaim.id}/lock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cKeys.humanKey}`,
      },
      body: JSON.stringify({}),
    });
    const unsealed = await fetch(`${c}/v1/evidence/${unsealedClaim.id}`);
    const cfo_unsealed = { status: unsealed.status, ...(await json(unsealed)) };

    const claim = await json(
      await fetch(`${c}/v1/claims`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cKeys.agentKey}`,
        },
        body: JSON.stringify({
          title: "AI spend is $12.00 this period",
          narrative: "Token ledger supports the board claim.",
          agentId: "agt_lease",
        }),
      }),
    );
    await fetch(`${c}/v1/claims/${claim.id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "lease-register.csv", content: "L-1,warehouse,24000\n" }),
    });
    await fetch(`${c}/v1/claims/${claim.id}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", tokens: 1200, amountCents: 12 }),
    });
    await fetch(`${c}/v1/claims/${claim.id}/lock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cKeys.humanKey}`,
      },
      body: JSON.stringify({}),
    });
    const leaseAttach = await json(
      await fetch(`${c}/v1/engines/lease`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claimId: claim.id,
          leaseId: "L-1",
          description: "warehouse",
          periods: 24,
          amount: 1000,
          annualIbr: 0.06,
          transfersOwnership: true,
        }),
      }),
    );
    const evidence = await json(await fetch(`${c}/v1/evidence/${claim.id}`));
    const pack = (evidence.pack ?? evidence) as Record<string, unknown>;
    const docs = Array.isArray(pack.documents) ? pack.documents : [];
    const cfo_evidence = {
      ledgerOk: evidence.ledgerOk,
      pack: {
        controlId: pack.controlId,
        claimId: pack.claimId,
        agentId: pack.agentId,
        lockState: pack.lockState,
        documents: docs.map((d) =>
          pick(d as Record<string, unknown>, ["id", "name", "sha256"]),
        ),
        tokenSources: Array.isArray(pack.tokenSources) ? pack.tokenSources.length : 0,
        engines: Array.isArray(pack.engines) ? pack.engines.length : 0,
      },
      sigPreview: String(evidence.sig ?? "").slice(0, 24) + "…",
    };

    const schedule = Array.isArray(leaseAttach.schedule) ? leaseAttach.schedule : [];
    const cfo_lease = {
      leaseId: leaseAttach.leaseId,
      classification: leaseAttach.classification,
      periods: schedule.length,
      opening: pick((schedule[0] ?? {}) as Record<string, unknown>, [
        "period",
        "payment",
        "interest",
        "closingLiability",
      ]),
      closing: pick((schedule.at(-1) ?? {}) as Record<string, unknown>, [
        "period",
        "payment",
        "interest",
        "closingLiability",
      ]),
    };

    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          gateway_call,
          gateway_sse,
          gateway_rotate,
          spend_auto,
          spend_countersign,
          spend_settle,
          cfo_unsealed,
          cfo_evidence,
          cfo_lease,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("wrote", outFile);
  } finally {
    gServer.close();
    sServer.close();
    cServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
