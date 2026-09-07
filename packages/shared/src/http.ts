import http from "node:http";
import { URL } from "node:url";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  body: Json | undefined,
) => Promise<void> | void;

export async function readJson(req: http.IncomingMessage): Promise<Json | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as Json;
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: http.OutgoingHttpHeaders,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

export function createServer(handler: Handler): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readJson(req);
      await handler(req, res, url, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("listen failed"));
    });
    server.on("error", reject);
  });
}

export function openSse(res: http.ServerResponse): {
  send: (event: string, data: unknown, id?: string) => void;
  close: () => void;
} {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  return {
    send(event, data, id) {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      res.end();
    },
  };
}

export async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}
