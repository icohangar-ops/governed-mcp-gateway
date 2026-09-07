import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
import { loadClaimAllowlistFixture, mintFixtureJwt } from "../src/claim-allowlist.ts";
import { GovernedGateway } from "../src/gateway.ts";

const fixture = loadClaimAllowlistFixture();

async function start() {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  return { gateway, keys, server, base };
}

async function rpc(base: string, token: string | undefined, method: string, params?: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

test("invalid token is rejected and does not list tools", async () => {
  const { server, base } = await start();
  try {
    const listed = await rpc(base, "mcp_not_a_real_key", "tools/list");
    assert.equal(listed.status, 401);
    assert.equal(listed.json.reason, "invalid");
    assert.equal(listed.json.result, undefined);
    const called = await rpc(base, "not-a-token", "tools/call", { name: "echo.ping" });
    assert.equal(called.status, 401);
    assert.equal(called.json.reason, "invalid");
  } finally {
    server.close();
  }
});

test("expired claim token is rejected", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.expired);
    const res = await rpc(base, token, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "expired");
  } finally {
    server.close();
  }
});

test("wrong-audience claim token is rejected", async () => {
  const { server, base } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.wrongAud);
    const res = await rpc(base, token, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "wrong_aud");
  } finally {
    server.close();
  }
});

test("wrong-scope token cannot call an allowlisted tool", async () => {
  const { server, base, gateway } = await start();
  try {
    const token = mintFixtureJwt(fixture, fixture.cases.echoOnly);
    const listed = await rpc(base, token, "tools/list", { mode: "full" });
    assert.equal(listed.status, 200);
    const names = listed.json.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("echo.ping"));
    assert.ok(!names.includes("stripe.charge"));

    const res = await rpc(base, token, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 100 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.error.code, -32001);
    assert.ok(gateway.ledger.records.some((r) => r.event === "tool.denied"));
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});

test("tools/list is filtered by principal allowlist", async () => {
  const { server, base } = await start();
  try {
    const packed = await rpc(base, "mcp_agt_research_demo", "tools/list");
    assert.equal(packed.status, 200);
    const packNames = packed.json.result.tools.map((t: { name: string }) => t.name);
    assert.ok(packNames.includes("echo.ping"));
    assert.ok(!packNames.includes("stripe.charge"));
    assert.ok(!packNames.includes("search.web"));

    const res = await rpc(base, "mcp_agt_research_demo", "tools/list", { mode: "full" });
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("echo.ping"));
    assert.ok(names.includes("search.web"));
    assert.ok(!names.includes("stripe.charge"));
  } finally {
    server.close();
  }
});

test("empty allowlist does not fall through to all tools", async () => {
  const gateway = new GovernedGateway();
  gateway.registerAgent(
    { id: "agt_empty", kind: "agent", orgId: "org_acme", displayName: "Empty" },
    "mcp_agt_empty_demo",
    [],
    0,
    0,
  );
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const listed = await rpc(base, "mcp_agt_empty_demo", "tools/list");
    assert.equal(listed.status, 200);
    const emptyNames = listed.json.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(emptyNames, ["context.inspect", "context.need"]);
    const full = await rpc(base, "mcp_agt_empty_demo", "tools/list", { mode: "full" });
    const fullNames = full.json.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(fullNames, ["context.inspect", "context.need"]);
    assert.ok(!fullNames.includes("echo.ping"));
    assert.ok(!fullNames.includes("stripe.charge"));
    const called = await rpc(base, "mcp_agt_empty_demo", "tools/call", { name: "echo.ping" });
    assert.equal(called.status, 200);
    assert.equal(called.json.error.code, -32001);
  } finally {
    server.close();
  }
});

test("sequential calls re-resolve principal and do not reuse identity", async () => {
  const { server, base, keys } = await start();
  try {
    const first = await rpc(base, keys.agentKey, "tools/call", { name: "echo.ping" });
    const second = await rpc(base, "mcp_agt_research_demo", "tools/call", { name: "echo.ping" });
    assert.equal(first.json.result._meta.cubiczan.principal.id, "agt_payops");
    assert.equal(second.json.result._meta.cubiczan.principal.id, "agt_research");
    assert.equal(first.json.result._meta.principal.id, "agt_payops");
    assert.equal(second.json.result._meta.principal.id, "agt_research");
  } finally {
    server.close();
  }
});

test("allow records a signed tool.called ledger event", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "world" },
    });
    assert.equal(res.status, 200);
    const called = [...gateway.ledger.records].reverse().find((r) => r.event === "tool.called");
    assert.equal(called?.actor, "agt_payops");
    assert.equal((called?.inputs as { name?: string } | undefined)?.name, "echo.ping");
    assert.ok(called?.sig);
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});

test("allowlist deny is signed and does not run the tool", async () => {
  const { server, base, gateway } = await start();
  try {
    const res = await rpc(base, "mcp_agt_research_demo", "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 100 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.error.code, -32001);
    const denied = [...gateway.ledger.records].reverse().find((r) => r.event === "tool.denied");
    assert.equal(denied?.actor, "agt_research");
    assert.equal((denied?.inputs as { name?: string } | undefined)?.name, "stripe.charge");
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});

test("stripe.charge over policy max requires human lock", async () => {
  const { server, base, keys } = await start();
  try {
    const pending = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 8000 },
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.error.code, -32004);
    assert.match(String(pending.json.error.message), /pending_human|CHP|human/i);
  } finally {
    server.close();
  }
});
