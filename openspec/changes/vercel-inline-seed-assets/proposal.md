# Change: Inline production seed data (no test/fixtures on Vercel)

## Why

Vercel Production for governed-mcp-gateway is Ready, but every request returns HTTP 500:

```
ENOENT: no such file or directory, open '/var/task/test/fixtures/claim-allowlist.json'
```

`createSeededGateway()` / `GovernedGateway` construction loads seed JSON via `import.meta.url` + `../test/fixtures/…`. After esbuild emits `dist/web.mjs`, that path becomes `/var/task/test/fixtures/…`. Fluid `includeFiles` is `dist/**`, so test fixtures are not in the lambda. Local checkouts have the files; Vercel does not.

An earlier tsx `./cjs/index.cjs` crash is already fixed by the compiled `dist/web.mjs` entry. This change is only the remaining fixture ENOENT.

## What Changes

- Production web/seed path uses **inline TypeScript seed data**. No `readFileSync` of `test/fixtures/` on the `api/index.mjs` → `dist/web.mjs` graph.
- Claim→tool allowlist seed lives in `src/claim-allowlist.ts` (same shape as the cookbook fixture). Oversized schema recipe is the existing in-source constant, not a runtime file read.
- Keep Streamable HTTP, `/health` 200 without auth, `/mcp` Bearer via `GATEWAY_AGENT_KEY`, Fluid, `public/` outputDirectory, no runtime tsx. Do not hardcode a Vercel hostname.

## Capabilities

- `mcp-gateway`: Vercel Fluid seeded gateway does not read test fixtures from the filesystem.

## Impact

- Gateway seed modules, `tool-catalog.ts` (drop FS fallback), constructor wiring, web tests, README, OpenSpec delta.
- Local `:7474` / `node --import tsx` tests stay on source TypeScript and keep passing.
- Non-goals: includeFiles of `test/fixtures/**`, JWT cookbook merge, live Stripe/x402, hardcoding a hostname, changing stdio/Docker CMD.
