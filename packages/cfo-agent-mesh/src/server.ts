import { listen } from "@cubiczan/shared";
import { CfoMesh } from "./mesh.ts";

const mesh = new CfoMesh();
mesh.seedDemo();
const port = Number(process.env.PORT ?? 7476);
const server = mesh.createHttpServer();
await listen(server, port);
console.log(`cfo-agent-mesh listening on http://127.0.0.1:${port}`);
