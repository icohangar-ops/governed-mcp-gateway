# Design: explicit public/ for Vercel Other preset

## Current state

`vercel.json` runs `npm run build` (esbuild → `dist/web.mjs`) and packs `api/index.mjs` with `includeFiles: dist/**`. There is no static site. After the compile-to-JS fix, Production still failed because the Other preset looks for `public/` whenever a custom `buildCommand` ran.

## Decisions

1. **Commit an empty `public/`.** A `.gitkeep` is enough. The Fluid function is the product; static files are only there so Vercel’s output-directory check passes.

2. **Set `outputDirectory` to `"public"`.** Omitting it or setting `null` was ignored on trust-ledger-os-mcp. Prefer the explicit folder name the error message asks for.

3. **Do not move `dist/` into `public/`.** `dist/web.mjs` stays a function include (`includeFiles: dist/**`). `outputDirectory` is the static dir, not the lambda bundle.

4. **Keep the compiled Fluid contract.** Install/build still produce `dist/web.mjs`. Rewrites, Bearer via `GATEWAY_AGENT_KEY`, and no runtime tsx stay as they are.

## Trade-offs

- An empty `public/` is a dummy artifact. That is cheaper than switching presets or inventing a static homepage.

## Non-goals

- Changing Streamable HTTP, session stores, or Glama stdio.
- Purchasing or hardcoding a production hostname.
