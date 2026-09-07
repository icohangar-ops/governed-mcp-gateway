import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listen } from "@cubiczan/shared";
import { GovernedGateway } from "../src/gateway.ts";
import { handleWebRequest, resetSeededWebGateway } from "../src/web.ts";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot(), rel), "utf8");
}

async function web(
  path: string,
  init: RequestInit = {},
  gateway?: GovernedGateway,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers; text: string }> {
  const request = new Request(`http://127.0.0.1${path}`, init);
  const response = gateway ? await gateway.handleWebRequest(request) : await handleWebRequest(request);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { status: response.status, json, headers: response.headers, text };
}

function rpcInit(method: string, params?: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}

test("GET /health and /healthz are unauthenticated liveness", async () => {
  resetSeededWebGateway();
  for (const path of ["/health", "/healthz"]) {
    const res = await web(path);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.service, "governed-mcp-gateway");
    assert.equal(res.json.transport, "streamable-http");
    assert.equal(res.json.mode, "stateless");
    assert.doesNotMatch(res.text, /mcp_agt_/);
    assert.doesNotMatch(res.text, /mcp_human_/);
  }
});

test("POST /mcp initialize without Bearer is 401", async () => {
  const gateway = new GovernedGateway();
  gateway.seedDemo();
  const res = await web("/mcp", rpcInit("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "glama-smoke", version: "0" },
  }), gateway);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal(res.json.error, "unauthorized");
});

test("POST /mcp initialize with Bearer is stateless JSON", async () => {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const res = await web("/mcp", rpcInit("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "glama-smoke", version: "0" },
  }, keys.agentKey), gateway);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("mcp-session-id"), null);
  const result = res.json.result as { protocolVersion?: string; serverInfo?: { name?: string } };
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.equal(result.serverInfo?.name, "governed-mcp-gateway");
});

test("Vercel rewrite destination /api still serves MCP", async () => {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const listed = await web("/api", rpcInit("tools/list", undefined, keys.agentKey), gateway);
  assert.equal(listed.status, 200);
  const tools = (listed.json.result as { tools?: Array<{ name: string }> })?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("echo.ping"));
  assert.ok(!names.includes("docs.mega_schema"));
});

test("tools/call on Streamable HTTP still injects principal", async () => {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const res = await web("/mcp", rpcInit("tools/call", {
    name: "echo.ping",
    arguments: { hello: "glama" },
  }, keys.agentKey), gateway);
  assert.equal(res.status, 200);
  const result = res.json.result as { _meta?: { cubiczan?: { principal?: { id?: string } } } };
  assert.equal(result._meta?.cubiczan?.principal?.id, "agt_payops");
});

test("GET /mcp does not open SSE", async () => {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const denied = await web("/mcp", { method: "GET" }, gateway);
  assert.equal(denied.status, 401);
  const res = await web("/mcp", {
    method: "GET",
    headers: { authorization: `Bearer ${keys.agentKey}` },
  }, gateway);
  assert.equal(res.status, 405);
});

test("Node listener delegates /health and Bearer /mcp", async () => {
  const gateway = new GovernedGateway();
  const keys = gateway.seedDemo();
  const server = gateway.createHttpServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.mode, "stateless");

    const healthz = await fetch(`${base}/healthz`);
    assert.equal(healthz.status, 200);

    const init = await fetch(`${base}/mcp`, rpcInit("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "listener", version: "0" },
    }, keys.agentKey));
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), null);
  } finally {
    server.close();
  }
});

test("vercel.json and api/index.mjs follow Fluid Compute shape without a hostname", () => {
  const vercel = JSON.parse(readRepo("vercel.json")) as {
    fluid?: boolean;
    rewrites?: Array<{ source: string; destination: string }>;
    functions?: Record<string, unknown>;
  };
  assert.equal(vercel.fluid, true);
  const sources = new Set((vercel.rewrites ?? []).map((r) => r.source));
  assert.ok(sources.has("/mcp"));
  assert.ok(sources.has("/health"));
  assert.ok(sources.has("/healthz"));
  assert.ok((vercel.rewrites ?? []).every((r) => r.destination === "/api"));
  assert.ok(vercel.functions && "api/index.mjs" in vercel.functions);

  const entry = readRepo("api/index.mjs");
  assert.match(entry, /handleWebRequest/);
  assert.match(entry, /async fetch\(request\)/);
  assert.match(entry, /\$VERCEL_URL/);
  assert.doesNotMatch(entry, /\.vercel\.app/);
  assert.doesNotMatch(readRepo("vercel.json"), /\.vercel\.app/);
  assert.doesNotMatch(readRepo("README.md"), /\.vercel\.app/);
});

test("Fluid fetch entry serves /health and Bearer initialize", async () => {
  resetSeededWebGateway();
  const mod = (await import(join(repoRoot(), "api/index.mjs"))) as {
    default: { fetch: (request: Request) => Promise<Response> };
  };
  const health = await mod.default.fetch(new Request("http://127.0.0.1/health"));
  assert.equal(health.status, 200);
  const healthJson = (await health.json()) as { ok?: boolean; mode?: string };
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.mode, "stateless");

  const denied = await mod.default.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
  );
  assert.equal(denied.status, 401);

  const init = await mod.default.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mcp_agt_payops_demo",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fluid", version: "0" } },
      }),
    }),
  );
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), null);
});
