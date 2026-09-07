# mcp-gateway Specification

## ADDED Requirements

### Requirement: tools/list schema cost is estimated and recorded
The gateway SHALL estimate the context cost of each `tools/list` tool schema using a documented bytes-to-token heuristic (`ceil(utf8_bytes / 4)`). The estimate SHALL be recorded on the HMAC audit ledger and exposed on the list result `_meta.cubiczan.tax` object. Cost SHALL be attributable per server and per tool.

#### Scenario: Listed payload records tax
- GIVEN an authenticated principal
- WHEN the client sends `tools/list`
- THEN the JSON-RPC result includes `_meta.cubiczan.tax.bytes` and `_meta.cubiczan.tax.tokens`
- AND the ledger contains a `schema.tax.recorded` event for that principal

### Requirement: Oversized tool packs are flagged
The gateway SHALL flag a tool or pack when its estimated tokens meet or exceed the configured threshold. The context-tax report SHALL include the flag and the max/min server cost ratio for the registered catalog.

#### Scenario: Synthetic oversized schema is flagged
- GIVEN the catalog includes `docs.mega_schema` from the oversized fixture
- WHEN an operator requests the context-tax report
- THEN `docs.mega_schema` is marked oversized
- AND pack `bloat` is flagged
- AND the estate max/min token ratio is greater than 100

### Requirement: Default tools/list exposes a minimal pack
The gateway SHALL NOT dump every allowlisted tool schema on an unscoped `tools/list`. The default session pack SHALL be catalog meta-tools plus allowlisted `core` tools.

#### Scenario: PayOps default list hides payments
- GIVEN principal `agt_payops` is allowlisted for `echo.ping` and `stripe.charge`
- WHEN it calls `tools/list` with no `need`, `pack`, or `mode=full`
- THEN the result includes `echo.ping` and `context.inspect`
- AND the result does not include `stripe.charge`

### Requirement: Allow-by-need is fail-closed against the principal allowlist
The gateway SHALL admit additional tools into a session only when they appear on that principal's allowlist (meta-tools excepted). A need request for a disallowed tool SHALL be denied, ledgers `schema.pack.denied`, and SHALL NOT appear on subsequent `tools/list`.

#### Scenario: Research cannot need stripe.charge
- GIVEN principal `agt_research` is allowlisted for `search.web` only among domain tools
- WHEN it sends `tools/list` with `params.need = ["stripe.charge"]`
- THEN `stripe.charge` is absent from the listed tools
- AND the ledger records `schema.pack.denied`

#### Scenario: PayOps can need the payments pack
- GIVEN principal `agt_payops`
- WHEN it sends `tools/list` with `params.pack = "payments"`
- THEN `stripe.charge` appears on the listed tools
- AND the session's exposed token cost increases by that schema's tax

### Requirement: Context inspector is authenticated
The gateway SHALL require a Bearer principal for context-tax and need HTTP paths. Missing credentials SHALL return HTTP 401.

#### Scenario: Unauthenticated tax report
- GIVEN a request with no Authorization header
- WHEN the client GET `/v1/context/tax`
- THEN the gateway returns HTTP 401
