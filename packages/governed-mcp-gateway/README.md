# Governed MCP Gateway

Port **7474**. Fail-closed Bearer auth. Principal re-resolved on every `tools/list` and `tools/call`, and repeated on every SSE frame. Schema token tax with pack / allow-by-need catalog.

Production MCP is stuck on auth. `SecurityContextHolder` / ThreadLocal dies when the tool runs on an SSE worker. VS Code secrets are keyed by `inputs[].id`, so rotating a token by renaming the input leaves the old secret alive. This SKU is a **control plane**, not a server catalog.

![Platform: gateway sits in front of spend and CFO mesh](docs/screenshots/architecture.png)

It:

- Resolves a Bearer credential to a **Principal** on every `tools/list` and `tools/call` (no JWT/Bearer stored on a session)
- Denies missing, invalid, expired, wrong-audience, and wrong-scope tokens — never falls through to all-tools
- Injects principal, allowed tools, and scopes into `params._meta.cubiczan` on every `tools/call`
- Repeats that identity on **every SSE event** so identity cannot drop with the handshake
- Filters `tools/list` by allowlist ∩ token scope and enforces the same intersection on `tools/call`
- Appends a signed `authz.decision` (canonical JSON + HMAC, `prevSig` chain) for allow and deny
- Binds CHP human locks to a tool + argument hash (changed arguments and replay are denied)
- Rotates vaulted MCP inputs in place (`github_token` stays `github_token`; the old hash stops verifying)
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

Demo keys: `mcp_agt_payops_demo` (PayOps: `echo.ping`, `stripe.charge`), `mcp_agt_research_demo` (no charge tool), `mcp_human_controller_demo` (vault + locks). Demo keys are opaque Bearers with implicit audience `mcp://governed-gateway` and scope `mcp.invoke`. Signed `czb1` claim tokens (HMAC, same ledger key) add `exp` / `aud` / `scope` for tests and adapters.

Token defects return HTTP **401** `{ error, reason }` (`missing` | `invalid` | `expired` | `wrong_audience` | `wrong_scope`). Disallowed tools return JSON-RPC `-32001` — they do not run. Over-cap `stripe.charge` returns `-32004` with a `lockId`; changed arguments after approval are `-32006`, replay of a consumed lock is `-32007`.

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


## Threat model

An allowlist is a catalog filter, not authorization. A principal may be allowed to *see* `stripe.charge` and still be denied if the Bearer grant does not include that tool or `mcp.invoke`. Confusing the two is how MCP servers fail open to all-tools after a partial auth check.

ThreadLocal / `SecurityContextHolder` principals are unsafe on MCP. `tools/list` often runs on the request thread; `tools/call` and SSE writes run on another worker. Identity that is not on the request (and on `_meta` of that call or frame) is gone. This gateway never stores a JWT on a session object and never reads identity from a thread-local.

Session reuse across users is unsafe. A long-lived SSE or JSON-RPC session that caches the first Bearer lets the next caller inherit that grant. Re-resolve from `Authorization` on every `tools/list` and `tools/call`. Two sequential calls with different keys on the same process must yield different principals.

Human approval without an argument hash is a replay oracle: approve $50, submit $5,000. Locks are single-use and bound to `sha256(canonicalJson(arguments))`.

## Layout

```
packages/governed-mcp-gateway/src/gateway.ts       HTTP + JSON-RPC + SSE + vault + locks
packages/governed-mcp-gateway/src/auth.ts          Fail-closed Bearer + czb1 claims
packages/governed-mcp-gateway/src/token-tax.ts     bytes→token heuristic + report types
packages/governed-mcp-gateway/src/tool-catalog.ts  packs + oversized fixture expansion
packages/governed-mcp-gateway/src/context-pack.ts  session packs, allow-by-need
packages/shared                                    CHP gate, HMAC ledger, SSE helper
```

Sister SKUs: [spend-mandate-plane](https://github.com/icohangar-ops/spend-mandate-plane) (`:7475`), [cfo-agent-mesh](https://github.com/icohangar-ops/cfo-agent-mesh) (`:7476`).

## License

MIT
