import { listen } from "@cubiczan/shared";
import { GovernedGateway } from "./gateway.ts";
import { parseSessionMode } from "./session-store.ts";

const gateway = new GovernedGateway({
  spendPlaneUrl: process.env.SPEND_PLANE_URL,
  sessionMode: process.env.MCP_SESSION_MODE ? parseSessionMode(process.env.MCP_SESSION_MODE) : undefined,
  replicaId: process.env.MCP_REPLICA_ID,
});
gateway.seedDemo();
const port = Number(process.env.PORT ?? 7474);
listen(gateway.createHttpServer(), port, "governed-mcp-gateway");
