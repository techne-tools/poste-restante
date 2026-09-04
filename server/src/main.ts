/**
 * Poste Restante — the letter server entry point.
 *
 *   npm run serve
 *
 * Builds the house (postgres + qdrant + ollama) and serves the letter
 * protocol over HTTP. The house is headless: this is the protocol face, not a
 * UI. Pull by default — nothing pushes.
 *
 * Authentication is mandatory: set AUTH_MODE=basic (or oidc/both) and issue
 * credentials with `npm run auth:add`. Without AUTH_MODE the house runs
 * unauthenticated — development only.
 */
import { serve } from "@hono/node-server";
import { buildHouse } from "./index.js";
import { createLetterServer } from "./server.js";
import { AuthService } from "./auth/service.js";
import { InviteService } from "./invites/service.js";
import { BookService } from "./book/service.js";
import { startGapScheduler } from "./whisper/scheduler.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);

const house = await buildHouse();
const auth = new AuthService(house.db.pool, house.log, house.config.auth);
const invites = new InviteService(house.db.pool, house.pipeline, auth);
const book = new BookService(
  house.db.pool,
  house.pipeline,
  house.repo,
  house.log,
  house.config.bookSettlingDays,
);
const app = createLetterServer(house, {
  // AUTH_MODE=none is development only: the house runs unauthenticated and
  // the caller is the default owner. The invite service still gets the
  // AuthService for its own checks (hasCredential).
  auth: auth.enabled ? auth : undefined,
  invites,
  book,
});

// The house breathes: the scheduled gap pass runs detectGaps per resident
// on its own rhythm (GAP_PASS_INTERVAL_MS), storing whispers the resident
// still pulls. Presence not pressure — the house holds, it never pushes.
const gapScheduler = startGapScheduler(house, auth, house.config.gapPassIntervalMs);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  house.log.info("server:listening", {
    port: info.port,
    authMode: house.config.auth.mode,
  });
});

// The house holds; it never interrupts. On shutdown it closes the archive
// cleanly so nothing is left half-written.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    house.log.info("server:shutdown", { signal });
    gapScheduler?.stop();
    await house.close();
    process.exit(0);
  });
}
