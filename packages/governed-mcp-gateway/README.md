# Governed MCP Gateway

Port **7474**. Principal on every `tools/call` and every SSE frame.

Production MCP is stuck on auth. `SecurityContextHolder` / ThreadLocal dies when the tool runs on an SSE worker. VS Code secrets are keyed by `inputs[].id`, so rotating a token by renaming the input leaves the old secret alive. This SKU is a **control plane**, not a server catalog.

![Platform: gateway sits in front of spend and CFO mesh](docs/screenshots/architecture.png)

It:

- Resolves a Bearer credential to a **Principal**
- Injects that principal into `params._meta.cubiczan.principal` on every `tools/call`
- Binds **host-only** tenant / index / vaulted input names onto `_meta.cubiczan.host` — the model does not choose them
- Repeats the principal on **every SSE event** so identity cannot drop with the handshake
- Rotates vaulted MCP inputs in place (`github_token` stays `github_token`; the old hash stops verifying)
- Enforces per-principal tool allowlists
- Measures `tools/list` schema **token tax** (description vs `inputSchema`) and exposes a **pack / allow-by-need** catalog instead of dumping every schema every turn
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

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, service }` |
| `POST` | `/mcp` | Bearer agent or human | JSON-RPC `initialize`, `tools/list`, `tools/call` |
| `GET` | `/mcp/sse` | Bearer | `notifications/message` with principal on `_meta` |
| `GET` | `/v1/context/tax` | Bearer | Schema token-tax ledger / estate report |
| `GET` | `/v1/context/packs` | Bearer | Named packs and per-server cost |
| `POST` | `/v1/context/need` | Bearer | Admit allowlisted tools or a pack into the session |
| `POST` | `/v1/credentials` | Human | Put a named secret |
| `POST` | `/v1/credentials/:name/rotate` | Human | New hash, same name, version++ |
| `POST` | `/v1/credentials/verify` | — | `{ ok: boolean }` |
| `POST` | `/v1/locks` | Human | CHP approve / reject |

Demo keys: `mcp_agt_payops_demo` (PayOps: `echo.ping`, `stripe.charge`, `index.query`), `mcp_agt_research_demo` (no charge tool), `mcp_human_controller_demo` (vault + locks).

Disallowed tools return JSON-RPC `-32001` — they do not run.

## Schema token tax and pack / allow-by-need

MCP clients hide how expensive `tools/list` is. Measured schema cost can vary ~1700× across servers; this gateway makes that tax visible and keeps it off the default context path.

**Heuristic:** `tokens = ceil(utf8_bytes / 4)`. Bytes are always recorded so the divisor is replaceable. No live tokenizer.

**Default `tools/list`** returns the session pack only: catalog meta-tools (`context.inspect`, `context.need`) plus allowlisted `core` tools (`echo.ping`). PayOps does **not** receive `stripe.charge` or `index.query` until it asks. The result `_meta.cubiczan.tax` has `bytes`, `tokens`, `savedTokens`, `flagged`, and `warnings`. Estate rows also split `descriptionTokens` vs `schemaTokens`.

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
| `tenant` | `index.query` | need / `pack=tenant` / `mode=full` (host binds tenant + index) |
| `bloat` | `docs.mega_schema` | never on demo allowlists |

## Cookbook

Clients want a subset of tools without forking the server. Hosts need tenant, index, and vaulted keys without the LLM choosing them. Fail-closed auth is unchanged: missing Bearer is HTTP 401.

### 1. Default `tools/list` is a session pack

```bash
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:7474/mcp
```

Expect `echo.ping`, `context.inspect`, `context.need`. Do **not** expect `stripe.charge` or `index.query`. `_meta.cubiczan.tax.mode` is `pack` and `savedTokens > 0`.

### 2. Allow-by-need (allowlist is the ceiling)

```bash
# PayOps may admit the payments pack
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"pack":"payments"}}' \
  http://127.0.0.1:7474/mcp

# Same via HTTP
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "X-Cubiczan-Session: ses_payops_need" \
  -H "Content-Type: application/json" \
  -d '{"tools":["stripe.charge"]}' \
  http://127.0.0.1:7474/v1/context/need

# Research cannot need stripe.charge — denied + schema.pack.denied
curl -sS -H "Authorization: Bearer mcp_agt_research_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"need":["stripe.charge"]}}' \
  http://127.0.0.1:7474/mcp
```

`params.mode=full` dumps every **allowlisted** schema (legacy). It still omits `docs.mega_schema`.

### 3. Estate token-tax report

```bash
curl -sS -H "Authorization: Bearer mcp_human_controller_demo" \
  http://127.0.0.1:7474/v1/context/tax
```

`estate.tools[]` has `bytes`, `tokens`, `descriptionTokens`, `schemaTokens`, `oversized`, `oversizedSchema`. Pack `bloat` and `docs.mega_schema` are flagged. Unauthenticated GET is **401**.

### 4. Host-injected `_meta` (tenant / index / vault)

The LLM fills `arguments`. The host binds the rest. `index.query` lists only `{ query }` — tenant and index are stripped from the schema.

```bash
# Bind index at the host. Tenant is always principal.orgId (org_acme).
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "X-Cubiczan-Index: kb_prod" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"index.query","arguments":{"query":"leases"}}}' \
  http://127.0.0.1:7474/mcp
```

Equivalent host `_meta` (not arguments):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "index.query",
    "arguments": { "query": "leases" },
    "_meta": { "cubiczan": { "host": { "index": "kb_prod" } } }
  }
}
```

The result `_meta.cubiczan.host` repeats `{ tenant, index, vault.github_token: { name, version } }`. No secret.

### 5. Negative: model invents host-only identifiers

These return JSON-RPC `-32006` and ledger `host.meta.denied`. The tool does not run.

```bash
# Invented tenant
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"index.query","arguments":{"query":"x","tenant":"org_other"}}}' \
  http://127.0.0.1:7474/mcp

# Invented vaulted input
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"world","github_token":"ghp_stolen"}}}' \
  http://127.0.0.1:7474/mcp

# Tenant header that is not the principal org
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "X-Cubiczan-Tenant: org_other" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"world"}}}' \
  http://127.0.0.1:7474/mcp
```

Also denied: `_meta.cubiczan.principal.id` impersonation, conflicting header vs `_meta` index claims, `index.query` with no host-bound index.

### 6. Vaulted inputs

VS Code `inputs[].id` stays `github_token`. Rotate in place; the old hash dies. The name is host-injected metadata, never a tool argument.

```bash
curl -sS -H "Authorization: Bearer mcp_human_controller_demo" \
  -H "Content-Type: application/json" \
  -d '{"secret":"ghp_new_secret_bbbb"}' \
  http://127.0.0.1:7474/v1/credentials/github_token/rotate
```

### Synthetic oversized fixture

[`test/fixtures/oversized-schema.json`](test/fixtures/oversized-schema.json) is a compact recipe. The gateway expands it into `docs.mega_schema` on server `synthetic.oversized` so the inspector can show a three-order-of-magnitude gap versus `echo.ping`. Thresholds (defaults): tool 512 tokens, pack 1024, listed payload 2048. Ledger events: `schema.tax.recorded`, `schema.pack.opened`, `schema.pack.denied`, `schema.pack.flagged`.

## Layout

```
packages/governed-mcp-gateway/src/gateway.ts       HTTP + JSON-RPC + SSE + vault
packages/governed-mcp-gateway/src/token-tax.ts     bytes→token heuristic + description/schema split
packages/governed-mcp-gateway/src/host-meta.ts     host-only bind / strip / deny
packages/governed-mcp-gateway/src/tool-catalog.ts  packs + oversized fixture expansion
packages/governed-mcp-gateway/src/context-pack.ts  session packs, allow-by-need
packages/shared                                    CHP gate, HMAC ledger, SSE helper
```

Sister SKUs: [spend-mandate-plane](https://github.com/icohangar-ops/spend-mandate-plane) (`:7475`), [cfo-agent-mesh](https://github.com/icohangar-ops/cfo-agent-mesh) (`:7476`).

## License

MIT
