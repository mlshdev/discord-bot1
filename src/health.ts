import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.ts";

export function startHealthServer(port: number, isReady: () => boolean, logger: Logger): Server {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    const ready = isReady();
    response
      .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
  });
  server.on("error", (error) => logger.error("health server error", { error }));
  server.listen(port, () => logger.info("health server listening", { port }));
  return server;
}
