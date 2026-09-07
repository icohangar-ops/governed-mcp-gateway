# mcp-gateway Specification

## ADDED Requirements

### Requirement: Host-only params are bound on `_meta`, not chosen by the model
The gateway SHALL bind tenant, index, and vaulted input metadata onto `params._meta.cubiczan.host` for every authenticated `tools/call`. Tenant SHALL equal the authenticated principal's `orgId`. Vault bindings SHALL include credential name and version and SHALL NOT include the secret. Listed tool schemas SHALL omit host-only properties.

#### Scenario: Host binds tenant and index
- GIVEN an authenticated principal `agt_payops` with `orgId = org_acme`
- AND the host sends `X-Cubiczan-Index: kb_prod`
- WHEN it calls `index.query` with arguments `{ "query": "leases" }`
- THEN the tool runs with host tenant `org_acme` and index `kb_prod`
- AND the result `_meta.cubiczan.host` includes those bindings
- AND `github_token` appears under `host.vault` with a version and without a secret

#### Scenario: Listed schema hides host-only keys
- GIVEN catalog tool `index.query` declares `hostOnly` tenant and index
- WHEN an authenticated principal lists tools with `need = ["index.query"]`
- THEN the listed `inputSchema.properties` does not include `tenant` or `index`

### Requirement: Invented host-only identifiers are denied
The gateway SHALL deny `tools/call` when tool `arguments` contain a host-only identifier, when host tenant claims disagree with `principal.orgId`, when header/query/`_meta` host claims conflict, or when `_meta.cubiczan.principal` impersonates another id or org. Denied calls SHALL ledger `host.meta.denied` and SHALL NOT run the tool.

#### Scenario: Model invents tenant in arguments
- GIVEN an authenticated principal
- WHEN it calls `index.query` with arguments `{ "query": "x", "tenant": "org_other" }`
- THEN the gateway returns JSON-RPC error `-32006`
- AND no tool implementation runs
- AND the ledger records `host.meta.denied`

#### Scenario: Model invents a vaulted input name
- GIVEN vaulted input `github_token`
- WHEN `tools/call` includes `arguments.github_token`
- THEN the gateway returns JSON-RPC error `-32006`

#### Scenario: Tenant header does not match the principal
- GIVEN principal `orgId = org_acme`
- WHEN the host sends `X-Cubiczan-Tenant: org_other`
- THEN `tools/call` is denied with `-32006`

#### Scenario: Client principal impersonation is denied
- GIVEN Bearer principal `agt_payops`
- WHEN `params._meta.cubiczan.principal.id` is `agt_research`
- THEN `tools/call` is denied with `-32006`

### Requirement: Schema and description token tax are recorded separately
The gateway SHALL estimate `tools/list` cost with `ceil(utf8_bytes / 4)` and SHALL attribute bytes/tokens to the tool description and to `inputSchema` independently. Oversized flags SHALL remain on the estate report. GET `/v1/context/tax` SHALL require a Bearer principal.

#### Scenario: Oversized fixture flags schema tax
- GIVEN the catalog includes `docs.mega_schema`
- WHEN an authenticated operator GET `/v1/context/tax`
- THEN `docs.mega_schema` is oversized
- AND its `schemaTokens` exceed its `descriptionTokens`
- AND pack `bloat` is flagged
- AND a missing Authorization header still returns HTTP 401

## MODIFIED Requirements

### Requirement: Default tools/list exposes a minimal pack
The default session pack remains catalog meta-tools plus allowlisted `core` tools. `index.query` is allowlisted for demo agents but SHALL NOT appear on an unscoped `tools/list`. Allow-by-need remains intersected with the principal allowlist.

#### Scenario: Default list still hides non-core tools
- GIVEN principal `agt_payops` is allowlisted for `echo.ping`, `stripe.charge`, and `index.query`
- WHEN it calls `tools/list` with no `need`, `pack`, or `mode=full`
- THEN the result includes `echo.ping` and `context.inspect`
- AND the result does not include `stripe.charge` or `index.query`
