# Change: Compile the Vercel Fluid entry to JS

## Why

Vercel Production for governed-mcp-gateway is Ready, but every request fails with HTTP 500 `FUNCTION_INVOCATION_FAILED` before auth. `/health` and `/mcp` both crash:

```
Cannot find module './cjs/index.cjs'
Require stack: /var/task/node_modules/tsx/dist/get-pipe-path-_tAJyU_v.mjs
```

`api/index.mjs` does `import "tsx"` then dynamically imports `packages/governed-mcp-gateway/src/web.ts`. Fluid/Node does not ship tsx’s CJS helper in the lambda bundle. A `tsc` pass on the workspace also fails with TS5097 because source imports use `.ts` extensions.

## What Changes

- Compile the Fluid handler to `dist/web.mjs` (esbuild bundle of the gateway + `@cubiczan/shared` graph).
- `api/index.mjs` imports that compiled JS. No runtime `tsx`. No `.ts` imports on the Vercel path.
- `vercel.json` runs `npm ci && npm run build` on install and again as `buildCommand` (esbuild, not `tsc`) so `dist/` exists before the function is packed. `includeFiles` is `dist/**`.
- Keep Streamable HTTP, `/mcp` `/health` `/healthz` rewrites, Bearer via `GATEWAY_AGENT_KEY`, Fluid `maxDuration` 60. Do not hardcode a Vercel hostname.

## Capabilities

- `mcp-gateway`: Vercel Fluid entry loads compiled JS, not TypeScript via runtime tsx.

## Impact

- Root `api/index.mjs`, `vercel.json`, `package.json` / lockfile (`esbuild` as a build dependency), `scripts/build-vercel.mjs`.
- Gateway web tests assert the entry does not import tsx and that the compiled bundle serves `/health` and Bearer `initialize`.
- Local `:7474` and `node --import tsx` tests stay on source TypeScript.
- Non-goals: rewriting workspace `.ts` imports to `.js`, changing stdio/Docker CMD, live Stripe/x402, hardcoding a hostname, mirroring icohangar-ops in this PR.
