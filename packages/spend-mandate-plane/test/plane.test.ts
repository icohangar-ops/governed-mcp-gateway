import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
import { SpendPlane } from "../src/plane.ts";

async function start() {
  const plane = new SpendPlane();
  const keys = plane.seedDemo();
  const server = plane.createHttpServer();
  const port = await listen(server, 0);
  return { plane, keys, server, base: `http://127.0.0.1:${port}` };
}

test("auto-execute under cap with covering mandate", async () => {
  const { plane, server } = await start();
  try {
    const proposal = plane.propose({
      agent: "agt_payops",
      merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
      total: "12.00",
      rationale: "metered tool call",
    });
    assert.equal(proposal.lane, "auto");
    assert.equal(proposal.chpState, "LOCKED");
    const settled = plane.settle(proposal.id, "stripe");
    assert.equal(settled.settled?.rail, "stripe");
    assert.ok(settled.settled?.reference.startsWith("evt_meter_"));
  } finally {
    server.close();
  }
});

test("over cap requires countersign and agent cannot countersign itself", async () => {
  const { plane, server } = await start();
  try {
    const proposal = plane.propose({
      agent: "agt_payops",
      merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
      total: "80.00",
      rationale: "large vendor payment",
    });
    assert.equal(proposal.lane, "approval");
    assert.throws(
      () =>
        plane.countersign(proposal.id, {
          id: "agt_payops",
          kind: "agent",
          orgId: "org_acme",
          displayName: "PayOps",
        }),
      /cannot countersign/,
    );
    const locked = plane.countersign(proposal.id, {
      id: "human.controller",
      kind: "human",
      orgId: "org_acme",
      displayName: "Controller",
    });
    assert.equal(locked.chpState, "LOCKED");
    const settled = plane.settle(proposal.id, "stripe");
    assert.equal(settled.settled?.rail, "stripe");
  } finally {
    server.close();
  }
});

test("x402 rail records payment-required without chain", async () => {
  const { plane, server } = await start();
  try {
    const proposal = plane.propose({
      agent: "agt_payops",
      merchant: { name: "Stripe", url: "https://stripe.com", country: "US" },
      total: "5.00",
      rationale: "x402 rail demo",
    });
    const settled = plane.settle(proposal.id, "x402");
    assert.equal(settled.settled?.rail, "x402");
    assert.ok(settled.settled?.reference.startsWith("x402_payreq_"));
  } finally {
    server.close();
  }
});
