# mcp-gateway Specification

## ADDED Requirements

### Requirement: Vercel Fluid entry loads compiled JavaScript
The repository Fluid entry SHALL import `handleWebRequest` from a compiled JavaScript module under `dist/`. It SHALL NOT import `tsx` at runtime and SHALL NOT import `.ts` sources on the Vercel path. A documented install/build command SHALL produce `dist/` before the function is packed.

#### Scenario: Fluid entry does not load tsx
- GIVEN the repository root
- WHEN a client reads `api/index.mjs`
- THEN it imports `handleWebRequest` from `dist/`
- AND it does not contain `import "tsx"`
- AND it does not import a `.ts` module

#### Scenario: Vercel install compiles the handler
- GIVEN `vercel.json`
- WHEN a client reads the install/build configuration
- THEN an install or build command runs `npm run build` (or `build:vercel`)
- AND the Fluid function `includeFiles` includes `dist/**`
