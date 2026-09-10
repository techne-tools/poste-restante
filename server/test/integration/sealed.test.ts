/**
 * Sealed letters — SPEC §15, integration tests.
 *
 * These prove the cryptographic horizon against live infra (postgres 15,
 * qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   register keys → seal a letter → deliver → stored but NOT indexed
 *   bad signature → rejected before anything is written
 *   unsealed letters → indexed as before (the regression guard)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import {
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
} from "../../src/crypto/keys.js";
import { letterIdFromCanonical, canonicaliseWith } from "../../src/id.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("sealed letters (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let you: Awaited<ReturnType<typeof generateResidentKeypair>>;

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
              address_keys
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, is_public) VALUES ('book@house', false), ('pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    app = createLetterServer(house, { auth });

    // Register you's public keys — the house holds only the public half.
    you = await generateResidentKeypair("you@house");
    await house.repo.setAddressKey("you@house", you.public);
  });

  afterAll(async () => {
    await house.close();
  });

  it("stores a sealed letter but never indexes it", async () => {
    const body = "the storm is coming — sealed";
    const ciphertext = await sealToRecipients(body, [you.public.ageRecipient]);
    const letter = {
      envelope: {
        from: "you@house",
        to: ["you@house"],
        cc: [],
        thread: "th_sealed_1",
        kind: "letter",
        lang: "en-AU",
        subject: "", // sealed letters carry no plaintext subject
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "sealed" as const,
        content: ciphertext,
        recipients: [you.public.ageRecipient],
        signature: "", // filled after the id is derived
      },
    };

    // The id is derived from the envelope+body with addresses resolved to
    // their identity ids (SPEC §19). you's keys are registered, so the
    // canonical form resolves you@house → the ed25519 public key — the
    // same form the pipeline derives. Sign that.
    const identities = new Map([["you@house", you.public.ed25519Public]]);
    const derived = letterIdFromCanonical(canonicaliseWith(letter as never, identities));
    letter.body.signature = signLetterId(derived, you.ed25519Private);

    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(letter),
    });
    expect(res.status).toBe(201);
    const { id: storedId } = (await res.json()) as { id: string };

    // The row exists, marked sealed, with the signature.
    const row = await house.repo.getLetter(storedId);
    expect(row).not.toBeNull();
    expect(row!.sealed).toBe(true);
    expect(row!.signature).toBe(letter.body.signature);
    // The body is ciphertext — the house never stored plaintext.
    expect(row!.body).toContain("AGE ENCRYPTED FILE");
    expect(row!.body).not.toContain("the storm is coming");
    // No plain-text extraction — FTS has nothing to index.
    expect(row!.body_text).toBe("");

    // Not in the semantic layer — a qdrant search for the plaintext finds nothing.
    const hits = await house.semantic.search(
      await house.embedder.embed("the storm is coming"),
      5,
    );
    expect(hits.some((h) => h.letterId === storedId)).toBe(false);
  });

  it("rejects a sealed letter with a bad signature", async () => {
    const ciphertext = await sealToRecipients("forged", [you.public.ageRecipient]);
    const letter = {
      envelope: {
        from: "you@house",
        to: ["you@house"],
        cc: [],
        thread: "th_sealed_forge",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "sealed" as const,
        content: ciphertext,
        recipients: [you.public.ageRecipient],
        signature: "not-a-real-signature",
      },
    };

    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(letter),
    });
    // The house does not store what it cannot verify.
    expect(res.status).toBe(400);
  });

  it("unsealed letters are still indexed — the regression guard", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_unsealed_1",
          kind: "letter",
          lang: "en-AU",
          subject: "the open letter",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "this one is open for the house to read" },
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const hits = await house.semantic.search(
      await house.embedder.embed("open for the house to read"),
      5,
    );
    expect(hits.some((h) => h.letterId === id)).toBe(true);
  });
});
