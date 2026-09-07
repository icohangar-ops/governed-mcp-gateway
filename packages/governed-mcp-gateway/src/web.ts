/**
 * Stateless Streamable HTTP entry used by Vercel Fluid Compute (`api/index.mjs`)
 * and tests. Same Bearer principal map as `npm run gateway`.
 *
 * Public URL after deploy: https://$VERCEL_URL/mcp
 * (do not hardcode a hostname in this repo).
 */
import { createSeededGateway, type GovernedGateway } from "./gateway.ts";

let cached: GovernedGateway | undefined;

export function seededWebGateway(): GovernedGateway {
  cached ??= createSeededGateway();
  return cached;
}

export function resetSeededWebGateway(): void {
  cached = undefined;
}

export function handleWebRequest(request: Request): Promise<Response> {
  return seededWebGateway().handleWebRequest(request);
}
