/**
 * Collaborative sealing — the house as participant (SPEC §15, second
 * model), integration tests.
 *
 * The house holds exactly one keypair — its own, a participant key,
 * never a master key. Collaborative letters encrypt to the recipient +
 * house@house; the house decrypts in memory, never stores plaintext.
 * Sealed letters encrypt to the recipients only — the house cannot open
 * them even compromised.
 *
 * Proven here against live infra:
 *   provision → buildHouse ensures the house key, mirrors public halves
 *   discover  → house@house carries a key record (public keys public)
 *   seal WITH → a resident's collaborative letter opens house-side
 *   seal only → a private letter stays closed house-side
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { HOUSE_ADDRESS } from "../../src/house/keys.js";
import { sealToRecipients, unsealWithIdentity } from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import { signLetterId } from "../../src/crypto/keys.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("collaborative sealing (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  // One resident keypair for the whole suite — the address record must
  // carry the SAME public halves the letters are signed with.
  let you: Awaited<ReturnType<typeof import("../../src/crypto/keys.js").generateResidentKeypair>>;

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
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings, retired_handles, house_keys
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    app = createLetterServer(house, { auth });

    // The resident's client-side keypair (same primitives the browser
    // uses) — registered so signatures verify and ids resolve.
    const { generateResidentKeypair } = await import("../../src/crypto/keys.js");
    you = await generateResidentKeypair("you@house");
    await house.repo.setAddressKey("you@house", you.public);

    // buildHouse's HouseKeysService.ensure() ran during the build and
    // mirrored the public halves. Confirm the house is discoverable.
    await house.houseKeys.ensure();
  });

  afterAll(async () => {
    await house.close();
  });

  it("provisions the house key and mirrors house@house into the address book", async () => {
    const key = await house.houseKeys.get();
    expect(key).not.toBeNull();

    const addr = await house.db.pool.query<{ id: string }>(
      `SELECT id FROM addresses WHERE id = $1`,
      [HOUSE_ADDRESS],
    );
    expect(addr.rows).toHaveLength(1);

    const bookRes = await app.request("/v1/addresses", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const book = (await bookRes.json()) as {
      addresses: { id: string; ageRecipient: string | null }[];
    };
    const houseRow = book.addresses.find((a) => a.id === HOUSE_ADDRESS);
    expect(houseRow).toBeDefined();
    expect(houseRow!.ageRecipient).toBe(key!.ageRecipient);

    // Meta carries the public halves — the composer's discovery door.
    const metaRes = await app.request("/v1/house/meta", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const meta = (await metaRes.json()) as {
      houseAddress: string;
      houseAgeRecipient: string | null;
    };
    expect(meta.houseAddress).toBe(HOUSE_ADDRESS);
    expect(meta.houseAgeRecipient).toBe(key!.ageRecipient);
  });

  it("a resident's collaborative seal opens house-side; a private seal does not", async () => {
    const houseKey = await house.houseKeys.get();
    expect(houseKey).not.toBeNull();

    // Collaborative: seal to the resident AND the house.
    const collaborativeText = "the house can read this one — tech week call notes";
    const collaborative = await sealToRecipients(collaborativeText, [
      you.public.ageRecipient,
      houseKey!.ageRecipient,
    ]);
    expect(await house.houseKeys.unsealBody(collaborative)).toBe(collaborativeText);
    expect(
      await unsealWithIdentity(collaborative, you.ageIdentity),
    ).toBe(collaborativeText);

    // Private: seal to the resident ONLY.
    const privateText = "only you — the cue sheet stays between us";
    const privateSeal = await sealToRecipients(privateText, [
      you.public.ageRecipient,
    ]);
    expect(await house.houseKeys.unsealBody(privateSeal)).toBeNull();
    expect(await unsealWithIdentity(privateSeal, you.ageIdentity)).toBe(privateText);
  });

  it("delivers a collaborative letter through the house — idempotent, stored sealed", async () => {
    const houseKey = await house.houseKeys.get();

    const ciphertext = await sealToRecipients("with the house — the grant round", [
      you.public.ageRecipient,
      houseKey!.ageRecipient,
    ]);

    // Build the letter the way the client does: subject moves into the
    // body, envelope subject empty, signed over the stored form.
    const letter = {
      envelope: {
        from: "you@house",
        to: [HOUSE_ADDRESS],
        cc: [],
        thread: "th_collab_1",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "sealed" as const,
        content: ciphertext,
        recipients: [you.public.ageRecipient, houseKey!.ageRecipient],
        signature: "",
      },
    };
    const identities = new Map([
      ["you@house", you.public.ed25519Public],
      [HOUSE_ADDRESS, houseKey!.ed25519Public],
    ]);
    const derived = letterIdFromCanonical(canonicaliseWith(letter as never, identities));
    (letter.body as { signature: string }).signature = signLetterId(
      derived,
      you.ed25519Private,
    );

    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(letter),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    // The house holds the letter; its participant key opens it.
    const stored = await house.repo.getLetter(id);
    expect(stored?.sealed).toBe(true);
    expect(stored?.to_addrs).toContain(HOUSE_ADDRESS);
    expect(await house.houseKeys.unsealBody(stored!.body)).toBe(
      "with the house — the grant round",
    );

    // Idempotent — same letter, same id.
    const again = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(letter),
    });
    expect(again.status).toBe(200);
    const againJson = (await again.json()) as { id: string; created: boolean };
    expect(againJson.created).toBe(false);
    expect(againJson.id).toBe(id);
  });
});
