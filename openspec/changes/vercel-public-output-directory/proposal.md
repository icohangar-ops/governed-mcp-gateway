# Change: Give Vercel Other preset an explicit public/ output directory

## Why

Vercel Production for governed-mcp-gateway compiled `dist/web.mjs` (esbuild) then failed:

```
Error: No Output Directory named "public" found after the Build completed.
Update vercel.json#outputDirectory to ensure the correct output directory is generated.
```

This is an API-only Fluid project. A custom `buildCommand` still makes the Other preset look for a static output folder. The same class of failure was fixed on trust-ledger-os-mcp by committing an empty `public/` and setting `outputDirectory` to `"public"`. A null / omitted `outputDirectory` is ignored.

## What Changes

- Add an empty root `public/` (`.gitkeep`) so the Other preset has a real static output dir.
- Set `vercel.json` `outputDirectory` to `"public"`.
- Keep install/build commands that emit `dist/web.mjs`, Fluid, rewrites `/mcp` `/health` `/healthz` → `/api`, `api/index.mjs` importing compiled JS, `includeFiles` `dist/**`, no runtime tsx.
- Do not change `GATEWAY_AGENT_KEY` Bearer behavior.

## Capabilities

- `mcp-gateway`: Vercel Other preset has an explicit empty `public/` output directory after the Fluid compile.

## Impact

- Root `public/.gitkeep`, `vercel.json`, gateway web tests, README Vercel table, OpenSpec delta.
- Non-goals: changing the esbuild bundle, Fluid entry, stdio/Docker, live Stripe/x402, hardcoding a hostname.
