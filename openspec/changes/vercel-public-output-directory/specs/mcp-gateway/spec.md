# mcp-gateway Specification

## ADDED Requirements

### Requirement: Vercel Other preset has an explicit public output directory
The repository root SHALL include a `public/` directory and `vercel.json` SHALL set `outputDirectory` to `public`. Install and build commands SHALL still produce `dist/web.mjs` for the Fluid entry. The Fluid function `includeFiles` SHALL remain `dist/**`. Bearer authentication via `GATEWAY_AGENT_KEY` SHALL be unchanged.

#### Scenario: outputDirectory is public
- GIVEN the repository root
- WHEN a client reads `vercel.json`
- THEN `outputDirectory` is `public`
- AND a `public/` directory exists
- AND install or build still runs `npm run build`
- AND the Fluid function `includeFiles` includes `dist/**`
