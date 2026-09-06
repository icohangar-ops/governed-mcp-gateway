import { listen } from "@cubiczan/shared";
import { SpendPlane } from "./plane.ts";

const plane = new SpendPlane();
plane.seedDemo();
const port = Number(process.env.PORT ?? 7475);
const server = plane.createHttpServer();
await listen(server, port);
console.log(`spend-mandate-plane listening on http://127.0.0.1:${port}`);
