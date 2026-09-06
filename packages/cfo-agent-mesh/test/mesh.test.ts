import assert from "node:assert/strict";
import { test } from "node:test";
import { CfoMesh } from "../src/mesh.ts";
import { levelPayments, rollforward } from "../src/engines/lease.ts";
import { measure } from "../src/engines/revenue.ts";
import { periodExpense } from "../src/engines/sbc.ts";

test("incomplete claim cannot seal", () => {
  const mesh = new CfoMesh();
  const claim = mesh.createClaim({
    title: "ROU increased",
    narrative: "Lease population grew",
    agentId: "agt_lease",
  });
  mesh.lock(claim.id, {
    id: "human.controller",
    kind: "human",
    orgId: "org_acme",
    displayName: "Controller",
  });
  assert.throws(() => mesh.seal(claim.id), /no source documents/);
});

test("complete claim seals with agent, lock, document, and token source", () => {
  const mesh = new CfoMesh();
  const claim = mesh.createClaim({
    title: "AI spend is $12.00 this period",
    narrative: "Token ledger supports the board claim.",
    agentId: "agt_lease",
  });
  mesh.addDocument(claim.id, "lease-register.csv", "L-1,warehouse,24000\n");
  mesh.recordTokens(claim.id, "gpt-4.1", 1200, 12);
  mesh.lock(claim.id, {
    id: "human.controller",
    kind: "human",
    orgId: "org_acme",
    displayName: "Controller",
  });
  const sealed = mesh.seal(claim.id) as {
    pack: { agentId: string; lockState: string; documents: unknown[]; tokenSources: unknown[] };
    ledgerOk: boolean;
  };
  assert.equal(sealed.pack.agentId, "agt_lease");
  assert.equal(sealed.pack.lockState, "LOCKED");
  assert.equal(sealed.pack.documents.length, 1);
  assert.equal(sealed.pack.tokenSources.length, 1);
  assert.equal(sealed.ledgerOk, true);
});

test("finance lease rollforward ends at zero liability", () => {
  const result = rollforward({
    leaseId: "L-1",
    description: "warehouse",
    payments: levelPayments(1000, 24),
    annualIbr: 0.06,
    transfersOwnership: true,
  });
  assert.equal(result.classification, "finance");
  assert.equal(result.schedule.at(-1)?.closingLiability, "0.00");
});

test("constrained POC revenue is 32.00 at 40% complete", () => {
  const result = measure({
    contractId: "C-1",
    description: "impl",
    timing: "over_time",
    transactionPrice: 100,
    constrainedPrice: 80,
    estimatedTotalCost: 100,
    costsIncurredToDate: 40,
    billingsToDate: 0,
  });
  assert.equal(result.poc, "0.4000");
  assert.equal(result.revenueToDate, "32.00");
});

test("SBC straight-line first year of a 4-year RSU", () => {
  const result = periodExpense(
    {
      grantId: "G-1",
      awardType: "rsu",
      grantDate: "2025-01-01",
      shares: 1000,
      serviceYears: 4,
      grantDateFv: 10,
    },
    "2025-01-01",
    "2026-01-01",
  );
  assert.equal(result.totalCost, "10000.00");
  assert.equal(result.periodCost, "2500.00");
});
