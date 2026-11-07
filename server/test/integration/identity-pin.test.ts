/**
 * The identity pin — SPEC §19, amended 2026-11-08 (integration, postgres only).
 *
 * The decision: `addresses.identity_id` is set ONCE, at an address's first key
 * registration, to that key's ed25519 fingerprint, and never moves afterwards.
 * A key is material the address holds over time; rotation retires it (030's
 * append-only `address_keys`) and moves no letter id.
 *
 * What these tests prove, in order:
 *
 *   first registration   → the identity is the new key's fingerprint
 *   rotate, rotate       → the identity does NOT move; three rows, one live
 *   a sealed letter      → naming the rotated recipient resolves to the PINNED
 *                          identity, and re-delivers to that ORIGINAL id.
 *                          This is the case that failed before the pin: the id
 *                          resolved to the recipient's live key, so a rotation
 *                          moved it and no candidate could re-derive it.
 *   a pre-pin client     → a letter sealed over the LIVE keys (what a client
 *                          that predates the `identityId` wire field computes)
 *                          still verifies, under the kept legacy rule
 *   an unsealed letter   → resolves to the pinned identity too (there is no
 *                          signature to fall back on, so this is the shape of
 *                          every letter written from now on)
 *
 * Postgres and nothing else: the pipeline is built with stub embedder/semantic
 * deps, so the semantic tier is not a prerequisite for an identity test. Gated
 * by POSTE_RESTANTE_INTEGRATION=1 like the rest of the integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDbAndMigrate, type Db } from "../../src/db/index.js";
import { PostgresRepository } from "../../src/db/repository.js";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import {
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
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

const RECIPIENT = "pin@house";
const WRITER = "writer@house";

describe.skipIf(!INTEGRATION)("the identity pin (integration)", () => {
  let db: Db;
  let repo: PostgresRepository;
  let pipeline: IngestionPipeline;

  /** Three generations for the recipient: the first pins, the rest rotate. */
  let first: ResidentKeypair;
  let second: ResidentKeypair;
  let third: ResidentKeypair;
  let writer: ResidentKeypair;

  /** Seal a body to a recipient and key it over the given resolution — which
   *  is exactly the choice under test, so it is a parameter. */
  async function sealedTo(
    recipientSeal: string,
    identities: Map<string, string>,
    gregorian: string,
    thread: string,
  ): Promise<{ letter: SealedLetter; id: string }> {
    const content = await sealToRecipients("the storm is coming — sealed", [recipientSeal]);
    const letter: SealedLetter = {
      envelope: {
        from: WRITER,
        to: [RECIPIENT],
        cc: [],
        thread,
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian, frames: [] },
      body: { format: "sealed", content, recipients: [recipientSeal], signature: "" },
    };
    const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
    letter.body.signature = signLetterId(id, writer.ed25519Private);
    return { letter, id };
  }

  const pinnedMap = () =>
    new Map([
      [WRITER, writer.public.ed25519Public],
      [RECIPIENT, first.public.ed25519Public],
    ]);

  const liveMap = () =>
    new Map([
      [WRITER, writer.public.ed25519Public],
      [RECIPIENT, third.public.ed25519Public],
    ]);

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
    // Both addresses start as themselves: no identity beyond the handle.
    await db.pool.query(
      `INSERT INTO addresses (id, identity_id) VALUES ($1, $1), ($2, $2)`,
      [RECIPIENT, WRITER],
    );

    first = await generateResidentKeypair(RECIPIENT);
    second = await generateResidentKeypair(RECIPIENT);
    third = await generateResidentKeypair(RECIPIENT);
    writer = await generateResidentKeypair(WRITER);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("the first registration pins the identity to that key's fingerprint", async () => {
    await repo.setAddressKey(RECIPIENT, first.public);
    await repo.setAddressKey(WRITER, writer.public);

    expect(await repo.getIdentityId(RECIPIENT)).toBe(first.public.ed25519Public);
    // The address book serves the same value — the client hashes from it.
    expect((await repo.getAddress(RECIPIENT))!.identityId).toBe(
      first.public.ed25519Public,
    );
    expect((await repo.listAddresses()).find((a) => a.id === RECIPIENT)!.identityId).toBe(
      first.public.ed25519Public,
    );
  });

  it("rotation retires the key, appends the next, and never moves the identity", async () => {
    await repo.setAddressKey(RECIPIENT, second.public);
    expect(await repo.getIdentityId(RECIPIENT)).toBe(first.public.ed25519Public);

    await repo.setAddressKey(RECIPIENT, third.public);

    // Two rotations, three generations, one identity.
    const history = await repo.getAddressKeyHistory(RECIPIENT);
    expect(history).toHaveLength(3);
    expect(history.filter((record) => record.retired_at === null)).toHaveLength(1);
    expect(history[0].ed25519_public).toBe(third.public.ed25519Public); // live, newest first
    expect(history[2].ed25519_public).toBe(first.public.ed25519Public); // the pin

    expect(await repo.getIdentityId(RECIPIENT)).toBe(first.public.ed25519Public);
    // And the live key is still served separately — sealing targets it.
    expect((await repo.getAddress(RECIPIENT))!.ed25519Public).toBe(
      third.public.ed25519Public,
    );
  });

  it("a sealed letter naming a rotated recipient re-delivers to its ORIGINAL id", async () => {
    const { letter, id } = await sealedTo(
      third.public.ageRecipient,
      pinnedMap(),
      "2026-11-08T10:00:00Z",
      "th_identity_pin",
    );

    // The id this letter is keyed under is the one the PINNED identity names,
    // not the live key — under the status quo the two differ and the letter
    // could not be re-derived at all.
    const legacy = letterIdFromCanonical(canonicaliseWith(letter, liveMap()));
    expect(legacy).not.toBe(id);

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: id, created: true });

    // Re-delivery after everything that could move has moved: same id, stored
    // once, verified against the writer's key.
    const again = await pipeline.ingest(letter);
    expect(again).toEqual({ letterId: id, created: false });
    const rows = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM letters WHERE thread_id = $1`,
      ["th_identity_pin"],
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it("still verifies a letter sealed over the live keys — the pre-pin client", async () => {
    // Exactly what a client that predates the `identityId` field computes: the
    // recipient's LIVE key, which after two rotations is not its identity.
    const { letter, id } = await sealedTo(
      third.public.ageRecipient,
      liveMap(),
      "2026-11-08T10:30:00Z",
      "th_identity_pin_legacy",
    );

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: id, created: true });
    // Not a rejection and not a new id: the legacy rule found the id the
    // signature covers.
    expect(result.rejected).toBeUndefined();
  });

  it("an unsealed letter resolves to the pinned identity too", async () => {
    const letter: Letter = {
      envelope: {
        from: WRITER,
        to: [RECIPIENT],
        cc: [],
        thread: "th_identity_pin_plain",
        kind: "letter",
        lang: "en-AU",
        subject: "no seal, still pinned",
      },
      time: { gregorian: "2026-11-08T11:00:00Z", frames: [] },
      body: { format: "markdown", content: "the identity is durable" },
    };
    const expected = letterIdFromCanonical(canonicaliseWith(letter, pinnedMap()));

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: expected, created: true });
  });

  it("a keyless address keeps its handle as its identity — no backfill", async () => {
    await db.pool.query(`INSERT INTO addresses (id, identity_id) VALUES ($1, $1)`, [
      "keyless@house",
    ]);
    expect(await repo.getIdentityId("keyless@house")).toBe("keyless@house");
    expect((await repo.getAddress("keyless@house"))!.identityId).toBe("keyless@house");
  });

  it("an OIDC binding follows the identity through the pin — rotation is no re-binding", async () => {
    // The binding is created while the address is still just its handle (the
    // claim step can happen before any key exists). Registering keys moves the
    // identity, and `oidc_bindings.identity_id` is ON UPDATE CASCADE (033), so
    // the binding travels with it instead of raising a foreign key error — the
    // latent defect that would have 500'd `POST /v1/addresses/:id/keys` for any
    // address that had bound OIDC first.
    const address = "logind@house";
    await db.pool.query(`INSERT INTO addresses (id, identity_id) VALUES ($1, $1)`, [address]);
    await db.pool.query(
      `INSERT INTO oidc_bindings (identity_id, provider, sub) VALUES ($1, 'voidauth', 'sub-pin')`,
      [address],
    );

    const keys = await generateResidentKeypair(address);
    const rotated = await generateResidentKeypair(address);

    const resolveSub = async () => {
      const { rows } = await db.pool.query<{ address: string }>(
        `SELECT a.id AS address
           FROM oidc_bindings ob
           JOIN addresses a ON a.identity_id = ob.identity_id
          WHERE ob.provider = 'voidauth' AND ob.sub = 'sub-pin'`,
      );
      return rows[0]?.address;
    };

    await repo.setAddressKey(address, keys.public);
    const { rows } = await db.pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM oidc_bindings WHERE sub = 'sub-pin'`,
    );
    expect(rows[0].identity_id).toBe(keys.public.ed25519Public);
    expect(await resolveSub()).toBe(address);

    // Rotation: the callback's join is untouched, because the identity is.
    await repo.setAddressKey(address, rotated.public);
    expect(await repo.getIdentityId(address)).toBe(keys.public.ed25519Public);
    expect(await resolveSub()).toBe(address);
  });
});
