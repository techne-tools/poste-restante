/**
 * Poste Restante — the letter server entry point.
 *
 *   npm run serve
 *
 * Builds the house (postgres + qdrant + ollama) and serves the letter
 * protocol over HTTP. The house is headless: this is the protocol face, not a
 * UI. Pull by default — nothing pushes.
 */
import { serve } from "@hono/node-server";
import { buildHouse } from "./index.js";
import { createLetterServer } from "./server.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);

const house = await buildHouse();
const app = createLetterServer(house);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  house.log.info("server:listening", { port: info.port });
});

// The house holds; it never interrupts. On shutdown it closes the archive
// cleanly so nothing is left half-written.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    house.log.info("server:shutdown", { signal });
    await house.close();
    process.exit(0);
  });
}
