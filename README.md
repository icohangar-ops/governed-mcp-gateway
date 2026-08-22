# @cubiczan/governed-mcp-gateway

HTTP MCP **control plane** (default port **7474**). Principal on every `tools/call` and every SSE frame — not a tool catalog.

Production MCP auth often dies when work hops threads or workers. This gateway resolves a Bearer credential to a **Principal**, injects it into `params._meta.cubiczan.principal`, repeats it on SSE, enforces allowlists, rotates vaulted secrets in place, and runs a lightweight CHP spend gate before priced tools.

## Install / run

```bash
npm i -g @cubiczan/governed-mcp-gateway   # or use npx
npx -y @cubiczan/governed-mcp-gateway
# → http://127.0.0.1:7474
```

From source:

```bash
npm install
npm run build
npm start
npm test
```

## Cursor / Claude config

Start the gateway in a terminal (or a process manager), then point the client at the HTTP MCP endpoints:

```json
{
  "mcpServers": {
    "governed-gateway": {
      "url": "http://127.0.0.1:7474/mcp",
      "headers": {
        "Authorization": "Bearer mcp_agt_payops_demo"
      }
    },
    "chp": {
      "command": "npx",
      "args": ["-y", "@cubiczan/chp-mcp"]
    },
    "conductor": {
      "command": "npx",
      "args": ["-y", "@cubiczan/agent-conductor"]
    }
  }
}
```

Demo keys: `mcp_agt_payops_demo`, `mcp_agt_research_demo`, `mcp_human_controller_demo`.

## Stack

```text
┌─────────────────┐     ┌──────────────────────────┐     ┌────────────────────┐
│ Cursor / Claude │────▶│ governed-mcp-gateway     │────▶│ spend-mandate-plane│
│ (MCP client)    │ SSE │ :7474  principal+vault   │ opt │ :7475              │
└────────┬────────┘     └────────────┬─────────────┘     └────────────────────┘
         │                           │
         │ stdio                     │ CHP gate (embedded)
         ▼                           ▼
┌─────────────────┐     ┌──────────────────────────┐
│ @cubiczan/      │     │ @cubiczan/chp-mcp        │
│ agent-conductor │     │ Profile B spend / HITL   │
└─────────────────┘     └──────────────────────────┘
```

Sister packages: [@cubiczan/chp-mcp](https://github.com/icohangar-ops/cubiczan-chp-mcp), [@cubiczan/agent-conductor](https://github.com/icohangar-ops/agent-conductor), [consensus-hardening-protocol](https://github.com/icohangar-ops/consensus-hardening-protocol).

## API

| Method | Path | Auth | What |
|--------|------|------|------|
| `GET` | `/health` | — | `{ ok, service }` |
| `POST` | `/mcp` | Bearer | JSON-RPC `initialize`, `tools/list`, `tools/call` |
| `GET` | `/mcp/sse` | Bearer | SSE with principal on `_meta` |
| `POST` | `/v1/credentials` | Human | Put a named secret |
| `POST` | `/v1/credentials/:name/rotate` | Human | New hash, same name |
| `POST` | `/v1/credentials/verify` | — | `{ ok }` |
| `POST` | `/v1/locks` | Human | CHP approve / reject |

```bash
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"world"}}}' \
  http://127.0.0.1:7474/mcp
```

## Notes

- This is an **HTTP** MCP gateway (JSON-RPC + SSE), not a stdio MCP process. The `governed-mcp-gateway` bin starts the HTTP server.
- Shared CHP / HTTP / ledger helpers are **vendored** under `src/shared/` (no `@cubiczan/shared` workspace dep).
- Optional: set `SPEND_PLANE_URL` to hook the spend-mandate plane before priced tools.

## License

MIT
