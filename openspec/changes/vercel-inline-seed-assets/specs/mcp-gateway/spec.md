# mcp-gateway Specification

## ADDED Requirements

### Requirement: Fluid seeded gateway does not read test fixtures
The compiled Fluid handler (`dist/web.mjs` imported by `api/index.mjs`) SHALL construct the seeded gateway from in-memory seed data. It SHALL NOT `readFileSync` (or otherwise open) `test/fixtures/claim-allowlist.json` or other `test/fixtures/` paths at runtime. `/health` SHALL return HTTP 200 without authentication. `/mcp` SHALL continue to require Bearer via `GATEWAY_AGENT_KEY` (or the demo default).

#### Scenario: compiled handler has no fixture filesystem reads
- GIVEN `npm run build` has produced `dist/web.mjs`
- WHEN a client inspects that bundle
- THEN it does not contain a runtime open of `test/fixtures/claim-allowlist.json`
- AND it does not contain a runtime open of `test/fixtures/oversized-schema.json`

#### Scenario: health works without a test/fixtures tree
- GIVEN the Fluid `fetch` handler
- WHEN a client sends `GET /health`
- THEN the status is 200
- AND the body has `ok=true` and `mode=stateless`
- AND construction does not throw ENOENT for claim-allowlist.json
