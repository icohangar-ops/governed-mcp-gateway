# Design: compiled Vercel Fluid entry

## Current state

`api/index.mjs` registers tsx at request time and imports the TypeScript workspace graph. `vercel.json` `includeFiles` ships `packages/**`. That works locally with a full `node_modules/tsx` tree. On Vercel Fluid the tsx package is incomplete (`./cjs/index.cjs` missing), so the function dies on first import — including unauthenticated `/health`.

`tsc` cannot emit this graph: `packages/shared/src/ledger.ts` (and the rest of the workspace) uses `.ts` import specifiers, which is TS5097 unless `allowImportingTsExtensions` is on (and that option does not emit a Node-runnable graph without a bundler).

## Decisions

1. **Bundle, do not run tsc on `.ts` specifiers.** `scripts/build-vercel.mjs` uses esbuild to emit one Node ESM file `dist/web.mjs` from `packages/governed-mcp-gateway/src/web.ts`. Workspace `@cubiczan/shared` is inlined. Node builtins stay external. No tsx in the output.

2. **trust-ledger-os-mcp / CodeSentinel runtime shape.** `api/index.mjs` is a thin Fluid `{ fetch }` wrapper that statically imports compiled JS (`../dist/web.mjs`). CodeSentinel imports a `.js` handler; trust-ledger-os-mcp imports `../dist/web-handler.js`. Same contract: the lambda never loads TypeScript.

3. **Build with esbuild, not tsc.** `installCommand` is `npm ci && npm run build`. `buildCommand` is `npm run build` so a dashboard leftover `tsc` (TS5097 on `.ts` imports) is overridden. `includeFiles` is `dist/**` (not `packages/**`). `dist/` stays gitignored; it is produced on the builder.

4. **Local workflow unchanged.** `npm start` / `npm test` in packages still use `node --import tsx` on `.ts` sources. Gateway tests call the build script before importing `api/index.mjs`.

5. **No hostname.** Comments and docs keep `$VERCEL_URL` / `$VERCEL_PROJECT_PRODUCTION_URL`. No `.vercel.app` literals.

## Trade-offs

- esbuild is a root dependency used only at build time. That is cheaper and more reliable than shipping tsx into the lambda.
- A full `tsc` + `.js` import rewrite across the monorepo would match trust-ledger’s compiler exactly, but it is unrelated churn for spend-plane and CFO mesh. The Vercel path only needs `handleWebRequest`.

## Non-goals

- Sticky sessions, Redis, or `Mcp-Session-Id`.
- Changing Glama stdio Dockerfile/CMD.
- Purchasing or hardcoding a production hostname.
