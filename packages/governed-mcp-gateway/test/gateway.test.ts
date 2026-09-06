import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "@cubiczan/shared";
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

test("missing credential is rejected", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, undefined, "tools/call", { name: "echo.ping" });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("tools/call injects principal", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", {
      name: "echo.ping",
      arguments: { hello: "world" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result._meta.cubiczan.principal.id, "agt_payops");
    const structured = res.json.result.structuredContent;
    assert.equal(structured.principal.id, "agt_payops");
  } finally {
    server.close();
  }
});

test("SSE event repeats principal", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await fetch(`${base}/mcp/sse?once=1`, {
      headers: { authorization: `Bearer ${keys.agentKey}` },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: message/);
    assert.match(text, /agt_payops/);
    assert.match(text, /cubiczan/);
  } finally {
    server.close();
  }
});

test("rotate named MCP input invalidates the old secret", async () => {
  const { server, base, keys, gateway } = await start();
  try {
    assert.equal(gateway.verifyCredential("github_token", "ghp_old_secret_aaaa"), true);
    const rotate = await fetch(`${base}/v1/credentials/github_token/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.humanKey}`,
      },
      body: JSON.stringify({ secret: "ghp_new_secret_bbbb" }),
    });
    const body = await rotate.json();
    assert.equal(rotate.status, 200);
    assert.equal(body.name, "github_token");
    assert.equal(body.version, 2);
    assert.equal(gateway.verifyCredential("github_token", "ghp_old_secret_aaaa"), false);
    assert.equal(gateway.verifyCredential("github_token", "ghp_new_secret_bbbb"), true);
  } finally {
    server.close();
  }
});

test("disallowed tool does not run", async () => {
  const { server, base } = await start();
  try {
    const res = await rpc(base, "mcp_agt_research_demo", "tools/call", {
      name: "stripe.charge",
      arguments: { amountCents: 100 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.error.code, -32001);
  } finally {
    server.close();
  }
});

function listedNames(json: { result?: { tools?: Array<{ name: string }> } }): string[] {
  return (json.result?.tools ?? []).map((t) => t.name).sort();
}

test("default tools/list is a minimal pack and records tax", async () => {
  const { server, base, gateway, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/list");
    assert.equal(res.status, 200);
    const names = listedNames(res.json);
    assert.ok(names.includes("echo.ping"));
    assert.ok(names.includes("context.inspect"));
    assert.ok(names.includes("context.need"));
    assert.ok(!names.includes("stripe.charge"));
    const tax = res.json.result._meta.cubiczan.tax;
    assert.equal(tax.mode, "pack");
    assert.equal(typeof tax.tokens, "number");
    assert.equal(typeof tax.bytes, "number");
    assert.ok(tax.savedTokens > 0);
    assert.ok(gateway.ledger.records.some((r) => r.event === "schema.tax.recorded"));
  } finally {
    server.close();
  }
});

test("PayOps can need the payments pack", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/list", { pack: "payments" });
    assert.equal(res.status, 200);
    const names = listedNames(res.json);
    assert.ok(names.includes("stripe.charge"));
    assert.ok(names.includes("echo.ping"));
  } finally {
    server.close();
  }
});

test("research cannot need stripe.charge", async () => {
  const { server, base, gateway } = await start();
  try {
    const res = await rpc(base, "mcp_agt_research_demo", "tools/list", {
      need: ["stripe.charge"],
    });
    assert.equal(res.status, 200);
    assert.ok(!listedNames(res.json).includes("stripe.charge"));
    const denied = gateway.ledger.records.find((r) => r.event === "schema.pack.denied");
    assert.ok(denied);
    assert.deepEqual((denied.inputs as { denied: string[] }).denied, ["stripe.charge"]);
  } finally {
    server.close();
  }
});

test("mode=full lists the allowlist and still omits the estate fixture", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/list", { mode: "full" });
    const names = listedNames(res.json);
    assert.ok(names.includes("stripe.charge"));
    assert.ok(!names.includes("docs.mega_schema"));
    assert.equal(res.json.result._meta.cubiczan.tax.mode, "full");
    assert.equal(res.json.result._meta.cubiczan.tax.savedTokens, 0);
  } finally {
    server.close();
  }
});

test("context inspector HTTP is fail-closed and flags the oversized fixture", async () => {
  const { server, base, keys } = await start();
  try {
    const denied = await fetch(`${base}/v1/context/tax`);
    assert.equal(denied.status, 401);

    const res = await fetch(`${base}/v1/context/tax`, {
      headers: { authorization: `Bearer ${keys.humanKey}` },
    });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.heuristic.bytesPerToken, 4);
    const mega = report.estate.tools.find((t: { name: string }) => t.name === "docs.mega_schema");
    assert.equal(mega.oversized, true);
    assert.ok(report.estate.flagged.includes("docs.mega_schema"));
    assert.ok(report.estate.flagged.includes("pack:bloat"));
    assert.ok(report.estate.ratioMaxMin > 100);
    const bloat = report.estate.servers.find((s: { server: string }) => s.server === "synthetic.oversized");
    const gatewayServer = report.estate.servers.find((s: { server: string }) => s.server === "governed-mcp-gateway");
    assert.ok(bloat.tokens > gatewayServer.tokens);
  } finally {
    server.close();
  }
});

test("POST /v1/context/need admits allowlisted tools into the session", async () => {
  const { server, base, keys } = await start();
  try {
    const need = await fetch(`${base}/v1/context/need`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.agentKey}`,
        "x-cubiczan-session": "ses_payops_need",
      },
      body: JSON.stringify({ tools: ["stripe.charge"] }),
    });
    assert.equal(need.status, 200);
    const body = await need.json();
    assert.ok(body.admitted.includes("stripe.charge"));

    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.agentKey}`,
        "x-cubiczan-session": "ses_payops_need",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const json = await listed.json();
    assert.ok(listedNames(json).includes("stripe.charge"));
  } finally {
    server.close();
  }
});

test("context.inspect tool returns session tax for the caller", async () => {
  const { server, base, keys } = await start();
  try {
    const res = await rpc(base, keys.agentKey, "tools/call", {
      name: "context.inspect",
      arguments: {},
    });
    assert.equal(res.status, 200);
    const report = res.json.result.structuredContent;
    assert.equal(report.session.principalId, "agt_payops");
    assert.ok(report.estate.ratioMaxMin > 100);
    assert.ok(!report.session.tools.includes("stripe.charge"));
  } finally {
    server.close();
  }
});

