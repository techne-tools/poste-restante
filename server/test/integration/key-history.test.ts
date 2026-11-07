/**
 * Key history — SPEC §15, integration tests (postgres only).
 *
 * 030 made `address_keys` append-only: one LIVE row per address (partial
 * unique index), retired rows kept. These tests prove the property that was
 * claimed and not implemented — a resident who re-registers their keys does
 * not destroy the old public key, and a letter sealed and signed under it
 * still verifies.
 *
 *   register keys      → one live generation
 *   seal + deliver     → stored, signed, indexed nowhere
 *   rotate             → the live row closes, the old row SURVIVES
 *   re-deliver         → created:false, SAME id (verified against the
 *                        retired key — not rejected, not duplicated)
 *   new letter         → seals to the new recipient, keyed by the new identity
 *   keyless legacy     → the identity IS the handle
 *
 * Postgres and nothing else: the pipeline is built with stub embedder/semantic
 * deps, so the semantic tier is not a prerequisite for a key test. Gated by
 * POSTE_RESTANTE_INTEGRATION=1 like the rest of the integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDbAndMigrate, type Db } from "../../src/db/index.js";
import { PostgresRepository } from "../../src/db/repository.js";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import {
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
  verifyLetterId,
  type ResidentKeypair,
} from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import type { Letter, SealedLetterBody } from "../../src/types.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5433/poste_restante_test";

/** A sealed letter — the body narrowed so the signature is addressable. */
type SealedLetter = Letter & { body: SealedLetterBody };

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!INTEGRATION)("key history (integration)", () => {
  let db: Db;
  let repo: PostgresRepository;
  let pipeline: IngestionPipeline;

  let before: ResidentKeypair;
  let after: ResidentKeypair;
  let preRotation: { letter: SealedLetter; id: string };

  /** Seal a body to a recipient, derive the id over the given resolution,
   *  and sign that id — exactly what the composer does. */
  async function sealed(
    from: string,
    to: string[],
    recipient: string,
    signingKey: string,
    identities: Map<string, string>,
  ): Promise<{ letter: SealedLetter; id: string }> {
    const content = await sealToRecipients("the storm is coming — sealed", [recipient]);
    const letter: SealedLetter = {
      envelope: { from, to, cc: [], thread: "th_key_history", kind: "letter", lang: "en-AU", subject: "" },
      time: { gregorian: "2026-11-08T09:00:00Z", frames: [] },
      body: { format: "sealed", content, recipients: [recipient], signature: "" },
    };
    const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
    letter.body.signature = signLetterId(id, signingKey);
    return { letter, id };
  }

  beforeAll(async () => {
    db = await connectDbAndMigrate(DATABASE_URL);
    repo = new PostgresRepository(db.pool);
    pipeline = new IngestionPipeline(
      repo,
      { upsert: async () => undefined, search: async () => [] } as never,
      { embed: async () => [0.1, 0.2] } as never,
      undefined,
      noopLog as never,
    );

    await db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys
       RESTART IDENTITY CASCADE`,
    );
    // Two residents: one who will hold keys, one who never will.
    await db.pool.query(
      `INSERT INTO addresses (id, identity_id) VALUES
         ('you@house', 'you@house'),
         ('legacy@house', 'legacy@house')`,
    );

    before = await generateResidentKeypair("you@house");
    after = await generateResidentKeypair("you@house");
  });

  afterAll(async () => {
    await db?.close();
  });

  it("registers the first key generation", async () => {
    await repo.setAddressKey("you@house", before.public);

    const history = await repo.getAddressKeyHistory("you@house");
    expect(history).toHaveLength(1);
    expect(history[0].ed25519_public).toBe(before.public.ed25519Public);
    expect(history[0].age_recipient).toBe(before.public.ageRecipient);
    expect(history[0].retired_at).toBeNull();
  });

  it("stores a sealed letter signed under the live key", async () => {
    preRotation = await sealed(
      "you@house",
      ["you@house"],
      before.public.ageRecipient,
      before.ed25519Private,
      new Map([["you@house", before.public.ed25519Public]]),
    );

    const result = await pipeline.ingest(preRotation.letter);
    expect(result).toEqual({ letterId: preRotation.id, created: true });

    const row = await repo.getLetter(preRotation.id);
    expect(row).not.toBeNull();
    expect(row!.sealed).toBe(true);
    expect(row!.signature).toBe(preRotation.letter.body.signature);
    // Opaque: the house stored ciphertext and never extracted plain text.
    expect(row!.body).toContain("AGE ENCRYPTED FILE");
    expect(row!.body).not.toContain("the storm is coming");
    expect(row!.body_text).toBe("");
  });

  it("rotation closes the live row and KEEPS the retired one", async () => {
    await repo.setAddressKey("you@house", after.public);

    const history = await repo.getAddressKeyHistory("you@house");
    expect(history).toHaveLength(2);

    const [live, retired] = history; // newest first
    expect(live.ed25519_public).toBe(after.public.ed25519Public);
    expect(live.retired_at).toBeNull();

    // The old public half survived — the whole point. Before 030 this row was
    // overwritten and the key was gone.
    expect(retired.ed25519_public).toBe(before.public.ed25519Public);
    expect(retired.age_recipient).toBe(before.public.ageRecipient);
    expect(retired.retired_at).not.toBeNull();
    expect(retired.retired_at!.getTime()).toBeGreaterThanOrEqual(retired.created_at.getTime());
  });

  it("sealing reads the live row, not the retired one", async () => {
    const address = await repo.getAddress("you@house");
    expect(address!.ageRecipient).toBe(after.public.ageRecipient);
    expect(address!.ed25519Public).toBe(after.public.ed25519Public);

    const book = await repo.listAddresses();
    const you = book.find((a) => a.id === "you@house");
    expect(you!.ageRecipient).toBe(after.public.ageRecipient);
  });

  it("a pre-rotation sealed letter still verifies and re-delivers to its ORIGINAL id", async () => {
    // The signature is over the id as of signing. After the rotation the live
    // key cannot reproduce that id, so this only passes if verification walks
    // the key history.
    const again = await pipeline.ingest(preRotation.letter);
    expect(again).toEqual({ letterId: preRotation.id, created: false });

    // Not a second row: the archive holds the letter once, under its own id.
    const rows = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM letters WHERE thread_id = $1`,
      ["th_key_history"],
    );
    expect(rows.rows[0].count).toBe("1");

    // And the stored signature verifies against the RETIRED key directly —
    // the public half is retained, public, and sufficient.
    const retired = (await repo.getAddressKeyHistory("you@house"))[1];
    const stored = await repo.getLetter(preRotation.id);
    expect(
      verifyLetterId(stored!.id, stored!.signature!, retired.ed25519_public),
    ).toBe(true);
  });

  it("re-registering the same key writes nothing", async () => {
    await repo.setAddressKey("you@house", after.public);
    expect(await repo.getAddressKeyHistory("you@house")).toHaveLength(2);
  });

  it("a new letter seals to the new recipient and keys on the new identity", async () => {
    const fresh = await sealed(
      "you@house",
      ["you@house"],
      after.public.ageRecipient,
      after.ed25519Private,
      new Map([["you@house", after.public.ed25519Public]]),
    );
    expect(fresh.id).not.toBe(preRotation.id);

    const result = await pipeline.ingest(fresh.letter);
    expect(result).toEqual({ letterId: fresh.id, created: true });

    const row = await repo.getLetter(fresh.id);
    expect(row).not.toBeNull();
    expect(row!.sealed).toBe(true);
  });

  it("a keyless legacy address still resolves to its handle", async () => {
    expect(await repo.getAddressKey("legacy@house")).toBeNull();
    expect(await repo.getAddressKeyHistory("legacy@house")).toEqual([]);

    const letter: Letter = {
      envelope: {
        from: "legacy@house",
        to: ["you@house"],
        cc: [],
        thread: "th_key_history_legacy",
        kind: "letter",
        lang: "en-AU",
        subject: "no keys here",
      },
      time: { gregorian: "2026-11-08T09:30:00Z", frames: [] },
      body: { format: "markdown", content: "the identity is the handle until a key exists" },
    };
    // The legacy address's own identity is its handle — it is absent from the
    // resolution map, so the canonical form keeps `legacy@house` as typed. The
    // recipient still resolves to its key: resolution is per handle, not per
    // property of the sender.
    const expectedId = letterIdFromCanonical(
      canonicaliseWith(letter, new Map([["you@house", after.public.ed25519Public]])),
    );

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: expectedId, created: true });
    expect(await repo.getLetter(expectedId)).not.toBeNull();
  });

  it("one live generation per address is structural, not a convention", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)
         VALUES ('you@house', 'age-rogue', 'ed-rogue', NULL)`,
      ),
    ).rejects.toThrow(/address_keys_one_active_idx|duplicate key value/);
  });

  it("rejects a sealed letter whose signature verifies under no generation", async () => {
    const forged = await sealed(
      "you@house",
      ["you@house"],
      after.public.ageRecipient,
      after.ed25519Private,
      new Map([["you@house", after.public.ed25519Public]]),
    );
    // A body swapped after signing: the signature no longer covers the id.
    forged.letter.body.content = await sealToRecipients("tampered", [after.public.ageRecipient]);

    const result = await pipeline.ingest(forged.letter);
    expect(result.created).toBe(false);
    expect(result.rejected).toBe(true);
    // The house does not store what it cannot verify.
    expect(await db.pool.query(`SELECT 1 FROM letters WHERE id = $1`, [result.letterId])).toMatchObject({
      rowCount: 0,
    });
  });

  it("rejects a sealed letter from a keyless address — nothing to verify with", async () => {
    const ciphertext = await sealToRecipients("unsigned", [after.public.ageRecipient]);
    const letter: Letter = {
      envelope: {
        from: "legacy@house",
        to: ["you@house"],
        cc: [],
        thread: "th_key_history_unsigned",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: "2026-11-08T09:45:00Z", frames: [] },
      body: { format: "sealed", content: ciphertext, recipients: [after.public.ageRecipient], signature: "nope" },
    };
    const result = await pipeline.ingest(letter);
    expect(result.rejected).toBe(true);
  });
});
