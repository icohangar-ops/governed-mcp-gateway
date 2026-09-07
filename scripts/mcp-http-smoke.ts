/**
 * Local Streamable HTTP smoke: /health then Bearer /mcp initialize.
 *
 *   npm run mcp:http:smoke
 *
 * Optional MCP_HTTP_URL probes a deployed URL (https://$VERCEL_URL/mcp).
 * This script never hardcodes a hostname.
 */
import type http from "node:http";
import { listen } from "@cubiczan/shared";
import { createSeededGateway } from "../packages/governed-mcp-gateway/src/gateway.ts";

const token = process.env.GATEWAY_AGENT_KEY ?? "mcp_agt_payops_demo";

async function main(): Promise<void> {
  const remote = process.env.MCP_HTTP_URL;
  let base = remote?.replace(/\/mcp\/?$/, "") ?? "";
  let server: http.Server | undefined;

  if (!base) {
    const gateway = createSeededGateway();
    server = gateway.createHttpServer();
    const port = await listen(server, 0);
    base = `http://127.0.0.1:${port}`;
  }

  try {
    const health = await fetch(`${base}/health`);
    if (!health.ok) throw new Error(`GET /health failed: HTTP ${health.status}`);
    const payload = (await health.json()) as { ok?: boolean; transport?: string };
    if (!payload.ok) throw new Error(`unexpected health: ${JSON.stringify(payload)}`);

    const unauth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      }),
    });
    if (unauth.status !== 401) throw new Error(`expected 401 without Bearer, got HTTP ${unauth.status}`);

    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      }),
    });
    if (!init.ok) throw new Error(`initialize failed: HTTP ${init.status}`);
    if (init.headers.get("mcp-session-id")) throw new Error("stateless initialize must not mint Mcp-Session-Id");
    const json = (await init.json()) as { result?: { serverInfo?: { name?: string } } };
    if (json.result?.serverInfo?.name !== "governed-mcp-gateway") {
      throw new Error(`unexpected initialize: ${JSON.stringify(json)}`);
    }
    console.log(`ok health=${payload.transport ?? "ok"} initialize=200 url=${base}/mcp`);
  } finally {
    server?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
