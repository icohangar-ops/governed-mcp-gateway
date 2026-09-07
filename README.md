# Cubiczan Agent Platform

Identity, money, and evidence for agents that actually ship.

Three SKUs, one workspace. MCP clients keep a Bearer principal through `tools/call` and SSE. Spend cannot settle without a mandate and, over cap, a human second key. Board claims cannot seal without an agent, a CHP lock, and a hashed document.

![Three SKUs: governed MCP gateway, spend mandate plane, CFO agent mesh](docs/screenshots/architecture.png)

| SKU | Port | Repo | Job |
|---|---|---|---|
| [Governed MCP Gateway](packages/governed-mcp-gateway) | `:7474` | [icohangar-ops/governed-mcp-gateway](https://github.com/icohangar-ops/governed-mcp-gateway) | Principal on every tool call and SSE frame. Claim→allowlist ∩ scope. Vaulted credential rotation. Schema token-tax ledger and pack / allow-by-need `tools/list`. |
| [Agent Spend & Mandate Plane](packages/spend-mandate-plane) | `:7475` | [icohangar-ops/spend-mandate-plane](https://github.com/icohangar-ops/spend-mandate-plane) | Propose → mandate → countersign → settle. Stripe by default; x402 is a rail. |
| [Auditable CFO Agent Mesh](packages/cfo-agent-mesh) | `:7476` | [icohangar-ops/cfo-agent-mesh](https://github.com/icohangar-ops/cfo-agent-mesh) | Claim → agent → lock → document. ASC 842 / 606 / 718 engines. HMAC-chained evidence pack. |

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

Production MCP drops identity. `listTools` runs on the request thread; `tools/call` and SSE run somewhere else. This gateway resolves a Bearer credential to a **Principal**, injects it on every JSON-RPC call, and repeats it on **every SSE frame**. Named vault inputs rotate in place — `github_token` stays `github_token`. Language-agnostic recipe: [Principal-on-RPC cookbook](docs/principal-on-rpc.md) ([Spring](docs/recipes/spring-ai.md), [Ballerina](docs/recipes/ballerina.md), [Python FastAPI](docs/recipes/python-fastapi.md)).

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
| `POST` | `/mcp` | JSON-RPC `initialize`, `tools/list` (default: session pack), `tools/call` |
| `GET` | `/mcp/sse?once=1` | SSE notification with `_meta.cubiczan.principal` |
| `GET` | `/v1/context/tax` | Schema token-tax estate + session report |
| `POST` | `/v1/context/need` | Admit allowlisted tools into the session pack |
| `POST` | `/v1/credentials/:name/rotate` | Human-only vault rotate; old hash dies |
| `POST` | `/v1/credentials/verify` | Check a secret against the current hash |

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

OpenSpec changes: [`ship-three-sku-platform`](openspec/changes/ship-three-sku-platform/), [`tools-list-token-tax`](openspec/changes/tools-list-token-tax/), [`principal-on-rpc-cookbook`](openspec/changes/principal-on-rpc-cookbook/).

## License

MIT
