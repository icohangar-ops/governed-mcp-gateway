# Governed MCP Gateway

[![Cubiczan/governed-mcp-gateway MCP server — quality and maintenance score on Glama](https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/badges/score.svg)](https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway)

Port **7474**. Principal on every `tools/call` and every SSE frame.

Production MCP is stuck on auth. `SecurityContextHolder` / ThreadLocal dies when the tool runs on an SSE worker. VS Code secrets are keyed by `inputs[].id`, so rotating a token by renaming the input leaves the old secret alive. This SKU is a **control plane**, not a server catalog.

![Platform: gateway sits in front of spend and CFO mesh](docs/screenshots/architecture.png)

It:

- Resolves a Bearer credential to a **Principal**
- Injects that principal into `params._meta.cubiczan.principal` on every `tools/call`
- Repeats the principal on **every SSE event** so identity cannot drop with the handshake
- Rotates vaulted MCP inputs in place (`github_token` stays `github_token`; the old hash stops verifying)
- Enforces per-principal tool allowlists
- Measures `tools/list` schema **token tax** and exposes a **pack / allow-by-need** catalog instead of dumping every schema every turn
- Optionally hooks the spend-mandate plane before a priced tool runs

## Live behavior

![Principal injected before the tool runs](docs/screenshots/gateway-principal.png)

![SSE repeats identity on each frame](docs/screenshots/gateway-sse.png)

![Rotate the vault, keep the input id](docs/screenshots/gateway-rotate.png)

## Run

From the platform root:

```bash
npm install
npm test -w @cubiczan/governed-mcp-gateway
npm run gateway
```

Stdio MCP (Glama / `npx`; NDJSON JSON-RPC on stdout, no HTTP port):

```bash
npm run mcp
```

Glama claim/build/release steps: [docs/glama-release.md](../../docs/glama-release.md).

Or in this package:

```bash
npm start
```

```bash
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"world"}}}' \
  http://127.0.0.1:7474/mcp
```

SSE (closes after one frame when `once=1`):

```bash
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  "http://127.0.0.1:7474/mcp/sse?once=1"
```

Rotate without minting a new VS Code input id (human key required):

```bash
curl -sS -H "Authorization: Bearer mcp_human_controller_demo" \
  -H "Content-Type: application/json" \
  -d '{"secret":"ghp_new_secret_bbbb"}' \
  http://127.0.0.1:7474/v1/credentials/github_token/rotate
```

## Glama remote connector

Hosted HTTPS is **stateless Streamable HTTP** (CodeSentinel Fluid Compute shape, Cubiczan brand). Glama health-checks `https://$VERCEL_URL/mcp` with Bearer auth. Do not hardcode a Vercel hostname.

Import this repository as a Vercel project:

| Setting | Value |
|---|---|
| Root Directory | `.` (repo root: `vercel.json` + `api/index.mjs`) |
| Framework Preset | Other |
| Fluid Compute | enabled |
| Install Command | `npm ci && npm run build` (set in `vercel.json`) |
| Build Command | `npm run build` (esbuild; do not use `tsc`) |
| Env | `GATEWAY_AGENT_KEY`, `GATEWAY_HUMAN_KEY`, `GATEWAY_RESEARCH_KEY` (rotate demo keys for a public URL) |

`npm run build` emits `dist/web.mjs`. The Fluid `fetch` handler imports that compiled JS and calls `handleWebRequest`. Do not run TypeScript through runtime `tsx` on Vercel. `vercel.json` rewrites `/mcp`, `/health`, and `/healthz` to `/api`. Local `:7474` uses the same handler for those paths. `GET /mcp/sse` stays on the Node listener only.

Local smoke:

```bash
npm run mcp:http:smoke
curl -sS http://127.0.0.1:7474/health
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  http://127.0.0.1:7474/mcp
```

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/health` `/healthz` | — | `{ ok, service, transport, mode }` |
| `POST` | `/mcp` | Bearer agent or human | Streamable HTTP JSON-RPC `initialize`, `tools/list`, `tools/call` |
| `GET` | `/mcp/sse` | Bearer | `notifications/message` with principal on `_meta` |
| `GET` | `/v1/context/tax` | Bearer | Schema token-tax ledger / estate report |
| `GET` | `/v1/context/packs` | Bearer | Named packs and per-server cost |
| `POST` | `/v1/context/need` | Bearer | Admit allowlisted tools or a pack into the session |
| `POST` | `/v1/credentials` | Human | Put a named secret |
| `POST` | `/v1/credentials/:name/rotate` | Human | New hash, same name, version++ |
| `POST` | `/v1/credentials/verify` | — | `{ ok: boolean }` |
| `POST` | `/v1/locks` | Human | CHP approve / reject |

Demo keys: `mcp_agt_payops_demo` (PayOps: `echo.ping`, `stripe.charge`), `mcp_agt_research_demo` (no charge tool), `mcp_human_controller_demo` (vault + locks).

Disallowed tools return JSON-RPC `-32001` — they do not run.

## Schema token tax and pack / allow-by-need

MCP clients hide how expensive `tools/list` is. Measured schema cost can vary ~1700× across servers; this gateway makes that tax visible and keeps it off the default context path.

**Heuristic:** `tokens = ceil(utf8_bytes / 4)`. Bytes are always recorded so the divisor is replaceable. No live tokenizer.

**Default `tools/list`** returns the session pack only: catalog meta-tools (`context.inspect`, `context.need`) plus allowlisted `core` tools (`echo.ping`). PayOps does **not** receive `stripe.charge` until it asks. The result `_meta.cubiczan.tax` has `bytes`, `tokens`, `savedTokens`, `flagged`, and `warnings`.

**Allow-by-need** admits extra tools into the session, always intersected with the principal allowlist (fail-closed). Session id is `X-Cubiczan-Session`, `params.sessionId`, or `params._meta.cubiczan.sessionId` (default `ses_<principalId>`).

```bash
# Minimal pack — echo + inspector, not stripe.charge
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:7474/mcp

# Admit the payments pack for this session
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"pack":"payments"}}' \
  http://127.0.0.1:7474/mcp

# Research cannot need stripe.charge — allowlist is the ceiling
curl -sS -H "Authorization: Bearer mcp_agt_research_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"need":["stripe.charge"]}}' \
  http://127.0.0.1:7474/mcp

# Estate report: per-server / per-tool tax, oversized flags, max/min ratio
curl -sS -H "Authorization: Bearer mcp_human_controller_demo" \
  http://127.0.0.1:7474/v1/context/tax
```

`params.mode=full` dumps every allowlisted schema (legacy). Oversized packs are **flagged** on the report and ledger (`schema.pack.flagged`), not silently dropped.

### Packs

| Pack | Tools | Default list |
|---|---|---|
| `catalog` | `context.inspect`, `context.need` | yes (authenticated) |
| `core` | `echo.ping` | yes if allowlisted |
| `payments` | `stripe.charge` | need / `pack=payments` / `mode=full` |
| `research` | `search.web` | need / `pack=research` / `mode=full` |
| `bloat` | `docs.mega_schema` | never on demo allowlists |

### Synthetic oversized fixture

[`test/fixtures/oversized-schema.json`](test/fixtures/oversized-schema.json) is a compact recipe. The gateway expands it into `docs.mega_schema` on server `synthetic.oversized` so the inspector can show a three-order-of-magnitude gap versus `echo.ping`. Thresholds (defaults): tool 512 tokens, pack 1024, listed payload 2048. Ledger events: `schema.tax.recorded`, `schema.pack.opened`, `schema.pack.denied`, `schema.pack.flagged`.

## Layout

```
packages/governed-mcp-gateway/src/gateway.ts       HTTP + JSON-RPC + SSE + vault
packages/governed-mcp-gateway/src/web.ts           seeded handleWebRequest (Vercel / tests)
packages/governed-mcp-gateway/src/token-tax.ts     bytes→token heuristic + report types
packages/governed-mcp-gateway/src/tool-catalog.ts  packs + oversized fixture expansion
packages/governed-mcp-gateway/src/context-pack.ts  session packs, allow-by-need
scripts/build-vercel.mjs + dist/web.mjs            compiled Fluid handler (no runtime tsx)
api/index.mjs + vercel.json                        Fluid Compute Streamable HTTP remote
packages/shared                                    CHP gate, HMAC ledger, SSE helper
```

Sister SKUs in this workspace: [spend-mandate-plane](../spend-mandate-plane) (`:7475`), [cfo-agent-mesh](../cfo-agent-mesh) (`:7476`). Listing: [Cubiczan/governed-mcp-gateway](https://github.com/Cubiczan/governed-mcp-gateway).

## License

MIT
