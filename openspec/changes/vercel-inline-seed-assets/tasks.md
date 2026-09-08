# Tasks

## 1. Spec and inline seed

- [x] 1.1 OpenSpec proposal, design, and mcp-gateway spec delta
- [x] 1.2 In-source claim-allowlist seed (no `readFileSync` of `test/fixtures/`)
- [x] 1.3 Oversized schema recipe is in-source only at runtime; on-disk fixture stays as a documented copy

## 2. Seeded web path

- [x] 2.1 `GovernedGateway` / `createSeededGateway()` load the in-memory claim seed in the constructor
- [x] 2.2 Keep Streamable HTTP, `/health` unauthenticated, Bearer `/mcp`, Fluid, `public/`, no runtime tsx, no hostname

## 3. Proof and docs

- [x] 3.1 Tests: bundle has no fixture FS reads; `/health` and Bearer initialize still work
- [x] 3.2 README notes that production seed is inlined, not packaged from `test/fixtures/`
