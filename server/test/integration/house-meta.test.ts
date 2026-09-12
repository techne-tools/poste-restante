/**
 * The house's own words at the door (SPEC §5 #14) — keyless by default,
 * keyed on request. Gated by POSTE_RESTANTE_INTEGRATION=1; runs against
 * live infra (postgres 15, qdrant).
 *
 * The payload is no sensitive state — room names, the domain, the house's
 * public keys — so the keyless door can greet a community by its own name.
 * HOUSE_META_PUBLIC=0 makes the read keyed again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("the house's own words at the door (integration)", () => {
  let house: House;
  let app: ReturnType<typeof createLetterServer>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses, credentials RESTART IDENTITY CASCADE`,
    );
    const auth = new AuthService(house.db.pool, house.log, house.config.auth);
    await auth.setPassword("you@house", "youyouyou");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("serves the meta keylessly by default — the door can introduce the house", async () => {
    const res = await app.request("/v1/house/meta");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      houseName: string;
      pubName: string;
      oidcEnabled: boolean;
    };
    expect(meta.houseName).toBeTruthy();
    expect(meta.pubName).toBeTruthy();
    // The login shows the provider door only when the house reports one.
    expect(typeof meta.oidcEnabled).toBe("boolean");
  });

  it("keys the meta on request — HOUSE_META_PUBLIC=0 answers the door's silence", async () => {
    house.config.houseMetaPublic = false;
    try {
      const keyless = await app.request("/v1/house/meta");
      expect(keyless.status).toBe(401);
      const keyed = await app.request("/v1/house/meta", {
        headers: { Authorization: basic("you@house", "youyouyou") },
      });
      expect(keyed.status).toBe(200);
    } finally {
      house.config.houseMetaPublic = true;
    }
  });
});
