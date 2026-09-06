import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
import { GATEWAY_AUDIENCE } from "../src/auth.ts";
import { GovernedGateway } from "../src/gateway.ts";

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
  return { status: res.status, json: await res.json() };
}

function lastDecision(gateway: GovernedGateway) {
  return [...gateway.ledger.records].reverse().find((r) => r.event === "authz.decision");
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
  const { server, base, gateway } = await start();
  try {
    const token = gateway.issueToken({
      sub: "agt_payops",
      aud: GATEWAY_AUDIENCE,
      scope: ["mcp.invoke"],
      exp: 1,
    });
    const res = await rpc(base, token, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "expired");
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.decision, "deny");
    assert.equal(decision?.inputs.reason, "expired");
  } finally {
    server.close();
  }
});

test("wrong-audience claim token is rejected", async () => {
  const { server, base, gateway } = await start();
  try {
    const token = gateway.issueToken({
      sub: "agt_payops",
      aud: "mcp://someone-else",
      scope: ["mcp.invoke"],
    });
    const res = await rpc(base, token, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "wrong_audience");
  } finally {
    server.close();
  }
});

test("wrong-scope token cannot call an allowlisted tool", async () => {
  const { server, base, gateway } = await start();
  try {
    const token = gateway.issueToken({
      sub: "agt_payops",
      aud: GATEWAY_AUDIENCE,
      scope: ["echo.ping"],
    });
    const listed = await rpc(base, token, "tools/list");
    assert.equal(listed.status, 200);
    const names = listed.json.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["echo.ping"]);
    assert.ok(!names.includes("stripe.charge"));

    const res = await rpc(base, token, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 100 },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.reason, "wrong_scope");
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.decision, "deny");
    assert.equal(decision?.inputs.reason, "wrong_scope");
    assert.equal(decision?.inputs.principalId, "agt_payops");
    assert.equal(decision?.inputs.tool, "stripe.charge");
    assert.ok(typeof decision?.inputs.argHash === "string" && decision.inputs.argHash.length === 64);
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});

test("tools/list is filtered by principal allowlist", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, "mcp_agt_research_demo", "tools/list");
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["echo.ping", "search.web"]);
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
    assert.deepEqual(listed.json.result.tools, []);
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
    assert.deepEqual(second.json.result._meta.cubiczan.allowedTools, ["echo.ping", "search.web"]);
  } finally {
    server.close();
  }
});

test("allow is a signed ledger decision", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "world" },
    });
    assert.equal(res.status, 200);
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.decision, "allow");
    assert.equal(decision?.inputs.tool, "echo.ping");
    assert.equal(decision?.inputs.principalId, "agt_payops");
    assert.equal(decision?.inputs.policyVersion, 1);
    assert.ok(decision?.sig);
    assert.equal(typeof decision?.prevSig, "string");
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
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.decision, "deny");
    assert.equal(decision?.inputs.reason, "allowlist");
    assert.equal(decision?.inputs.tool, "stripe.charge");
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});

test("changed arguments after CHP approval are denied", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    const pending = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 8000 },
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.error.code, -32004);
    const lockId = pending.json.error.data.lockId;
    assert.ok(lockId);

    const approved = await fetch(`${base}/v1/locks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.humanKey}`,
      },
      body: JSON.stringify({ lockId, decision: "approve" }),
    });
    assert.equal(approved.status, 200);

    const changed = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 9000 },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.error.code, -32006);
    assert.equal(changed.json.error.message, "changed_arguments");
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.reason, "changed_arguments");
  } finally {
    server.close();
  }
});

test("replay of a consumed CHP lock is denied", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    const pending = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 8000 },
    });
    const lockId = pending.json.error.data.lockId;
    const approved = await fetch(`${base}/v1/locks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.humanKey}`,
      },
      body: JSON.stringify({ lockId, decision: "approve" }),
    });
    assert.equal(approved.status, 200);

    const first = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 8000 },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.result.structuredContent.amountCents, 8000);

    const replay = await rpc(base, keys.agentKey, "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 8000 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.error.code, -32007);
    assert.equal(replay.json.error.message, "replay");
    const decision = lastDecision(gateway);
    assert.equal(decision?.inputs.reason, "replay");
    assert.equal(gateway.ledger.verify().ok, true);
  } finally {
    server.close();
  }
});
