#!/usr/bin/env node
/**
 * @cubiczan/governed-mcp-gateway — HTTP MCP control plane (default :7474).
 *
 *   npx -y @cubiczan/governed-mcp-gateway
 */

import { listen } from "./shared/index.js";
import { GovernedGateway } from "./gateway.js";

const gateway = new GovernedGateway({
  spendPlaneUrl: process.env.SPEND_PLANE_URL,
});
gateway.seedDemo();
const port = Number(process.env.PORT ?? 7474);
const server = gateway.createHttpServer();
await listen(server, port);
console.log(`governed-mcp-gateway listening on http://127.0.0.1:${port}`);
