# Design: tools/list token tax and pack/allow-by-need

## Decisions

1. **Heuristic, not a vendor tokenizer.** `tokens = ceil(utf8_bytes / 4)`. Tests never call live model APIs. The report records both bytes and tokens so an operator can swap the divisor later.

2. **Allowlist is the ceiling.** A session pack can only expose tools the principal is already allowlisted for, plus gateway meta-tools (`context.inspect`, `context.need`). Requesting `stripe.charge` for `agt_research` is denied and ledgers `schema.pack.denied`.

3. **Default list is a pack, not the estate.** Seed each session with meta-tools plus any allowlisted `core` tools (`echo.ping`). Payments, research, and bloat packs stay dark until `need` / `pack` / `mode=full`.

4. **Fail-closed auth stays.** Inspector HTTP routes and JSON-RPC `tools/list` require a Bearer principal. Missing credential is HTTP 401. Domain `tools/call` is unchanged (allowlist + CHP).

5. **Oversized is flagged, not silently dropped.** A full dump that exceeds thresholds is returned with `flagged: true` and a ledger event so the tax is visible. Minimization is the default path, not a hidden filter on `mode=full`.

6. **Synthetic estate server.** `docs.mega_schema` lives on server `synthetic.oversized` and pack `bloat`. It is registered in the catalog for the inspector ratio but is not on any demo allowlist.

## Session identity

`X-Cubiczan-Session`, `params.sessionId`, or `params._meta.cubiczan.sessionId`. If omitted, the session id is `ses_<principalId>`.

## Packs

| Pack | Tools |
|---|---|
| `catalog` | `context.inspect`, `context.need` |
| `core` | `echo.ping` |
| `payments` | `stripe.charge` |
| `research` | `search.web` |
| `tenant` | `index.query` (host-injected tenant / index; not in the default pack) |
| `bloat` | `docs.mega_schema` (fixture) |

## Thresholds (defaults)

- Tool: 512 tokens
- Pack: 1024 tokens
- Listed payload: 2048 tokens
