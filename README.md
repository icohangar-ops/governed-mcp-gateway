# Cubiczan Agent Platform

[![Cubiczan/governed-mcp-gateway MCP server — quality and maintenance score on Glama](https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/badges/score.svg)](https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway)

Identity, money, and evidence for agents that actually ship.

Three SKUs, one workspace. MCP clients keep a Bearer principal through `tools/call` and SSE. Spend cannot settle without a mandate and, over cap, a human second key. Board claims cannot seal without an agent, a CHP lock, and a hashed document.

![Three SKUs: governed MCP gateway, spend mandate plane, CFO agent mesh](docs/screenshots/architecture.png)

| SKU | Port | Source | Job |
|---|---|---|---|
| [Governed MCP Gateway](packages/governed-mcp-gateway) | `:7474` | [Cubiczan/governed-mcp-gateway](https://github.com/Cubiczan/governed-mcp-gateway) | Principal on every tool call and SSE frame. Vaulted credential rotation. Tool allowlists. Schema token-tax ledger and pack / allow-by-need `tools/list`. |
| [Agent Spend & Mandate Plane](packages/spend-mandate-plane) | `:7475` | this workspace | Propose → mandate → countersign → settle. Stripe by default; x402 is a rail. |
| [Auditable CFO Agent Mesh](packages/cfo-agent-mesh) | `:7476` | this workspace | Claim → agent → lock → document. ASC 842 / 606 / 718 engines. HMAC-chained evidence pack. |

Shared primitives (`packages/shared`): CHP gate, HMAC ledger, HTTP/SSE helpers. Zero runtime npm dependencies. Stripe and x402 are rails — tests never call live networks.

## Quickstart

```bash
npm install
npm test
npm run gateway   # :7474
npm run spend     # :7475
npm run cfo       # :7476
```

Demo Bearer keys (also in `.env.example`):

| Role | Key |
|---|---|
| Gateway agent | `mcp_agt_payops_demo` |
| Gateway human | `mcp_human_controller_demo` |
| Gateway research (no `stripe.charge`) | `mcp_agt_research_demo` |
| Spend agent | `spend_agt_payops_demo` |
| Spend human | `spend_human_controller_demo` |
| CFO agent | `cfo_agt_lease_demo` |
| CFO human | `cfo_human_controller_demo` |

Regenerate the README cards from live local APIs:

```bash
npm run shots
```

---

## 1. Governed MCP Gateway

Production MCP drops identity. `listTools` runs on the request thread; `tools/call` and SSE run somewhere else. This gateway resolves a Bearer credential to a **Principal**, injects it on every JSON-RPC call, and repeats it on **every SSE frame**. Named vault inputs rotate in place — `github_token` stays `github_token`.

![Principal injected on tools/call](docs/screenshots/gateway-principal.png)

![SSE repeats principal on every frame](docs/screenshots/gateway-sse.png)

![Rotate github_token without a new input id](docs/screenshots/gateway-rotate.png)

```bash
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"world"}}}' \
  http://127.0.0.1:7474/mcp
```

| Method | Path | What |
|---|---|---|
| `GET` | `/health` `/healthz` | Liveness (`{ ok, service, transport, mode }`). No auth. |
| `POST` | `/mcp` | Streamable HTTP JSON-RPC `initialize`, `tools/list` (default: session pack), `tools/call` |
| `GET` | `/mcp/sse?once=1` | Local SSE notification with `_meta.cubiczan.principal` (not the Vercel path) |
| `GET` | `/v1/context/tax` | Schema token-tax estate + session report |
| `POST` | `/v1/context/need` | Admit allowlisted tools into the session pack |
| `POST` | `/v1/credentials/:name/rotate` | Human-only vault rotate; old hash dies |
| `POST` | `/v1/credentials/verify` | Check a secret against the current hash |

### Glama remote connector

Glama can health-check a **stateless Streamable HTTP** remote at `https://$VERCEL_URL/mcp` with Bearer auth. This is the hosted HTTPS path. Stdio (`npm run mcp` / Dockerfile CMD) remains the Glama Docker build path.

**Vercel project settings** (import this GitHub repo; do not invent a hostname):

| Setting | Value |
|---|---|
| Root Directory | `.` (repository root — `vercel.json` + `api/`) |
| Framework Preset | Other (`vercel.json` sets `"framework": null`) |
| Fluid Compute | On (`"fluid": true`) |
| Node.js | 20 or later |
| Install Command | `npm ci && npm run build` (`vercel.json` already sets this) |
| Build Command | `npm run build` (esbuild → `dist/web.mjs`; do **not** run `tsc`) |
| Output Directory | `public` (empty static dir for the Other preset; Fluid still serves `/api`) |

`npm run build` runs `scripts/build-vercel.mjs` (esbuild). That emits `dist/web.mjs`. `api/index.mjs` imports that compiled file — it does **not** load TypeScript via runtime `tsx`. The Other preset still expects a static output folder after a custom `buildCommand`; `public/` is that folder (`outputDirectory: "public"`). If the Vercel dashboard still has a Build Command of `tsc`, clear it or set it to `npm run build` so TS5097 does not come back. Dashboard overrides are not required if `vercel.json` is honored.

**Environment variables** (Vercel Project → Settings → Environment Variables). Rotate the demo values before a public URL:

| Name | Local demo | Role |
|---|---|---|
| `GATEWAY_AGENT_KEY` | `mcp_agt_payops_demo` | Glama connector Bearer (PayOps allowlist) |
| `GATEWAY_HUMAN_KEY` | `mcp_human_controller_demo` | Vault / locks |
| `GATEWAY_RESEARCH_KEY` | `mcp_agt_research_demo` | Research allowlist (no `stripe.charge`) |
| `SPEND_PLANE_URL` | unset | Optional hook to `:7475` |

Glama connector fields after deploy (replace `$VERCEL_URL` with the deployment host Vercel prints):

- URL: `https://$VERCEL_URL/mcp`
- Transport: Streamable HTTP
- Authorization: `Bearer $GATEWAY_AGENT_KEY`

Local smoke (no public hostname):

```bash
npm run mcp:http:smoke
# or:
npm run gateway
curl -sS http://127.0.0.1:7474/health
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  http://127.0.0.1:7474/mcp
```

`initialize` does not mint `Mcp-Session-Id`. Pass `params.pack` / `params.need` on the same `tools/list` when you need more than the session pack. `GET /mcp` is 405 (no sticky SSE on the remote).

---

## 2. Agent Spend & Mandate Plane

Agents propose. Mandates authorize. A human countersigns when the amount is over the auto cap. The proposing agent **cannot** countersign itself. Settlement is a rail: Stripe meter event by default, x402 payment-required if you ask for it. No chain calls in this MVP.

![Under-cap proposal auto-locks](docs/screenshots/spend-auto.png)

![Over-cap requires a human second key](docs/screenshots/spend-countersign.png)

![Stripe meter vs x402 payment-required](docs/screenshots/spend-settle.png)

```bash
curl -sS -H "Authorization: Bearer spend_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"agent":"agt_payops","merchant":{"name":"Stripe","url":"https://stripe.com","country":"US"},"total":"12.00","rationale":"tool meter"}' \
  http://127.0.0.1:7475/v1/proposals
```

| Method | Path | What |
|---|---|---|
| `POST` | `/v1/mandates` | Operator creates remaining-cents coverage |
| `POST` | `/v1/proposals` | Agent propose; lane `auto` \| `approval` \| `blocked` |
| `POST` | `/v1/countersign` | Human second key; agents are rejected |
| `POST` | `/v1/settle` | `{ "rail": "stripe" }` or `"x402"` |

---

## 3. Auditable CFO Agent Mesh

A board claim is not done until it has an **agent**, a **LOCKED** CHP state, and at least one source document hash. Engines measure (ASC 842 lease rollforward, ASC 606 constrained POC, ASC 718 SBC). They do not decide facts of law. Token spend attaches as a source on the same HMAC-chained ledger.

![Unsealed claim without documents](docs/screenshots/cfo-unsealed.png)

![Sealed evidence pack](docs/screenshots/cfo-evidence.png)

![ASC 842 finance lease ends at 0.00](docs/screenshots/cfo-lease.png)

```bash
curl -sS -H "Authorization: Bearer cfo_agt_lease_demo" \
  -H "Content-Type: application/json" \
  -d '{"title":"AI spend is $12.00 this period","narrative":"Token ledger supports the board claim.","agentId":"agt_lease"}' \
  http://127.0.0.1:7476/v1/claims
```

| Method | Path | What |
|---|---|---|
| `POST` | `/v1/claims` | Open a claim |
| `POST` | `/v1/claims/:id/documents` | Attach a named source; SHA-256 stored |
| `POST` | `/v1/claims/:id/lock` | Human lock → `LOCKED` |
| `POST` | `/v1/engines/lease` | ASC 842 classification + rollforward |
| `GET` | `/v1/evidence/:id` | Seal; `400` if no documents or not locked |

## Specs

OpenSpec changes: [`ship-three-sku-platform`](openspec/changes/ship-three-sku-platform/), [`tools-list-token-tax`](openspec/changes/tools-list-token-tax/), [`glama-streamable-http-remote`](openspec/changes/glama-streamable-http-remote/), [`vercel-compiled-fluid-entry`](openspec/changes/vercel-compiled-fluid-entry/), [`vercel-public-output-directory`](openspec/changes/vercel-public-output-directory/).

## License

MIT
