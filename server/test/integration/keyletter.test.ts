/**
 * The keyletter — a letter that carries a public key (SPEC §15, migration 034).
 *
 * Integration, postgres only: the pipeline is built with stub embedder and
 * semantic deps, so the point is the SCHEMA and the KEY SPINE, not the index.
 *
 * What the suite proves, in order — the acceptance sketch of the card:
 *
 *   first sight     a validly signed keyletter from an address with no live key
 *                   records the keys with `origin = 'keyletter'` and the
 *                   letter's id as provenance, and does NOT move
 *                   `addresses.identity_id` (TOFU proves the key, not the
 *                   address).
 *   the round trip  a keyless correspondent becomes reachable: a sealed letter
 *                   TO them opens with the identity they published, and their
 *                   own sealed letter verifies against the installed key.
 *   the refusals    an unsigned or tampered keyletter is refused, and nothing
 *                   is written — no letter row, no key row.
 *   the change      a later keyletter whose keys DIFFER does not overwrite: it
 *                   raises one pending offer, and the live record stands until
 *                   a human answers.
 *   the answer      accepting installs the offered keys (still `keyletter`
 *                   origin, identity untouched) and settles the offer; a
 *                   registration with proof settles it too, and THAT is what
 *                   pins the identity.
 *   the privacy     only the address itself, or someone who can see the
 *                   keyletter, may answer — proven as a negative.
 *
 * Gated by POSTE_RESTANTE_INTEGRATION=1 like the rest of the integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDbAndMigrate, type Db } from "../../src/db/index.js";
import { PostgresRepository } from "../../src/db/repository.js";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import {
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
  unsealWithIdentity,
  type ResidentKeypair,
} from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import { applyKeyFrame, mayAnswerKeyOffer, verifyKeyFrame } from "../../src/keyletter.js";
import type { KeyFrameBody, Letter, SealedLetterBody } from "../../src/types.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5433/poste_restante_test";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A sealed letter — the body narrowed so the signature is addressable. */
type SealedLetter = Letter & { body: SealedLetterBody };
type KeyLetter = Letter & { body: KeyFrameBody };

const CORR = "newcorr@house";
const YOU = "you@house";
const STRANGER = "stranger@house";

describe.skipIf(!INTEGRATION)("the keyletter (integration)", () => {
  let db: Db;
  let repo: PostgresRepository;
  let pipeline: IngestionPipeline;

  let corr: ResidentKeypair;
  let corrNext: ResidentKeypair;
  let third: ResidentKeypair;
  let you: ResidentKeypair;

  /**
   * The identity map the CLIENT builds from the address book — read from the
   * same column the house resolves with, so a test that composes a letter here
   * proves the two derivations agree rather than assuming it.
   */
  async function identityMap(...handles: string[]): Promise<Map<string, string>> {
    const ids = await repo.getIdentityIds(handles);
    const map = new Map<string, string>();
    for (const handle of handles) map.set(handle, ids.get(handle) ?? handle);
    return map;
  }

  /** A keyletter as the client composes it: canonical form with identities
   *  resolved, sha256, then the signature over that id. */
  async function keyLetter(
    keys: ResidentKeypair["public"],
    privateKey: string,
    opts: { from?: string; to?: string; note?: string; gregorian?: string } = {},
  ): Promise<{ letter: KeyLetter; id: string }> {
    const from = opts.from ?? CORR;
    const to = opts.to ?? YOU;
    const letter: KeyLetter = {
      envelope: {
        from,
        to: [to],
        cc: [],
        thread: `th_key_${from.replace(/[^a-z]/g, "")}`,
        kind: "keyletter",
        lang: "en-AU",
        subject: "my keys",
      },
      time: { gregorian: opts.gregorian ?? "2026-11-08T12:00:00.000Z", frames: [] },
      body: {
        format: "keyframe",
        keys: {
          ageRecipient: keys.ageRecipient,
          ed25519Public: keys.ed25519Public,
          recoveryAgeRecipient: keys.recoveryAgeRecipient,
        },
        content: opts.note ?? "These are my keys — seal to me.",
        signature: "",
      },
    };
    const id = letterIdFromCanonical(canonicaliseWith(letter, await identityMap(from, to)));
    letter.body.signature = signLetterId(id, privateKey);
    return { letter, id };
  }

  /** A sealed letter from `writer` to `to`, keyed as the client keys it. */
  async function sealedLetter(input: {
    writer: ResidentKeypair;
    from: string;
    to: string;
    toKeys: ResidentKeypair;
    gregorian: string;
    plaintext: string;
  }): Promise<{ letter: SealedLetter; id: string }> {
    const content = await sealToRecipients(input.plaintext, [input.toKeys.public.ageRecipient]);
    const letter: SealedLetter = {
      envelope: {
        from: input.from,
        to: [input.to],
        cc: [],
        thread: `th_sealed_${input.gregorian.replace(/[^0-9]/g, "")}`,
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: input.gregorian, frames: [] },
      body: {
        format: "sealed",
        content,
        recipients: [input.toKeys.public.ageRecipient],
        signature: "",
      },
    };
    const id = letterIdFromCanonical(
      canonicaliseWith(letter, await identityMap(input.from, input.to)),
    );
    letter.body.signature = signLetterId(id, input.writer.ed25519Private);
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
              thread_participation, address_key_offers, letters, threads, frames,
              addresses, credentials, address_keys
       RESTART IDENTITY CASCADE`,
    );
    // Both addresses start as themselves: no identity beyond the handle.
    await db.pool.query(`INSERT INTO addresses (id, identity_id) VALUES ($1, $1), ($2, $2)`, [
      CORR,
      YOU,
    ]);

    corr = await generateResidentKeypair(CORR);
    corrNext = await generateResidentKeypair(CORR);
    third = await generateResidentKeypair(CORR);
    you = await generateResidentKeypair(YOU);
    // The resident has registered with proof — the identity spine exists.
    await repo.setAddressKey(YOU, you.public);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("installs a keyless correspondent's keys on first sight, and does not pin their identity", async () => {
    const { letter, id } = await keyLetter(corr.public, corr.ed25519Private);
    expect(verifyKeyFrame(id, letter.body)).toEqual({ ok: true });

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: id, created: true });

    // The keys are the correspondent's, whole.
    expect(await repo.getAddressKey(CORR)).toEqual({
      age_recipient: corr.public.ageRecipient,
      ed25519_public: corr.public.ed25519Public,
      recovery_age_recipient: null,
    });

    // The history says HOW they arrived, and which letter carried them.
    const history = await repo.getAddressKeyHistory(CORR);
    expect(history).toHaveLength(1);
    expect(history[0].origin).toBe("keyletter");
    expect(history[0].source_letter_id).toBe(id);

    // TOFU proves the key, not the address: the identity is still the handle.
    expect(await repo.getIdentityId(CORR)).toBe(CORR);
    expect((await repo.getAddress(CORR))!.identityId).toBe(CORR);

    // And the address book serves the keys — this is what makes them sealable.
    const book = await repo.listAddresses();
    expect(book.find((a) => a.id === CORR)!.ed25519Public).toBe(corr.public.ed25519Public);
    expect(book.find((a) => a.id === CORR)!.keyOffer).toBeNull();
  });

  it("makes them reachable — a sealed letter reaches them, and theirs verifies", async () => {
    // To them: sealed to the age recipient the keyletter published.
    const toThem = await sealedLetter({
      writer: you,
      from: YOU,
      to: CORR,
      toKeys: corr,
      gregorian: "2026-11-08T13:00:00.000Z",
      plaintext: "welcome — this is the first sealed letter you can open",
    });
    expect((await pipeline.ingest(toThem.letter)).created).toBe(true);

    // It opens with the identity they hold — the point of the whole card.
    expect(await unsealWithIdentity(toThem.letter.body.content, corr.ageIdentity)).toEqual({
      ok: true,
      plaintext: "welcome — this is the first sealed letter you can open",
    });

    // From them: signed with the key the keyletter installed, so the house's
    // verification path (the sender's key history) finds it.
    const fromThem = await sealedLetter({
      writer: corr,
      from: CORR,
      to: YOU,
      toKeys: you,
      gregorian: "2026-11-08T13:30:00.000Z",
      plaintext: "thank you — sealed, at last",
    });
    const result = await pipeline.ingest(fromThem.letter);
    expect(result).toEqual({ letterId: fromThem.id, created: true });
    expect(result.rejected).toBeUndefined();
  });

  it("refuses a tampered keyletter, and writes nothing", async () => {
    const other = await generateResidentKeypair(CORR);
    const { letter } = await keyLetter(other.public, other.ed25519Private, {
      gregorian: "2026-11-08T14:00:00.000Z",
    });
    // Tamper AFTER signing: the frame now publishes an age recipient the
    // signature does not cover, so the id it hashes to is not the id signed.
    const tampered: KeyLetter = {
      ...letter,
      body: {
        ...letter.body,
        keys: { ...letter.body.keys, ageRecipient: you.public.ageRecipient },
      },
    };
    const before = await db.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM letters`);

    const result = await pipeline.ingest(tampered);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe("bad_signature");

    const after = await db.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM letters`);
    expect(after.rows[0].c).toBe(before.rows[0].c);
    // The live record is untouched: still the first key's.
    expect((await repo.getAddressKey(CORR))!.ed25519_public).toBe(corr.public.ed25519Public);
  });

  it("refuses an unsigned keyletter as unsigned — a different silence", async () => {
    const { letter } = await keyLetter(corrNext.public, corrNext.ed25519Private, {
      gregorian: "2026-11-08T14:10:00.000Z",
    });
    const unsigned: KeyLetter = { ...letter, body: { ...letter.body, signature: "" } };
    const result = await pipeline.ingest(unsigned);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe("unsigned");
    expect((await repo.getAddressKey(CORR))!.ed25519_public).toBe(corr.public.ed25519Public);
  });

  it("does not overwrite a live key: a differing keyletter raises one pending offer", async () => {
    const { letter, id } = await keyLetter(corrNext.public, corrNext.ed25519Private, {
      gregorian: "2026-11-08T15:00:00.000Z",
    });
    expect(await pipeline.ingest(letter)).toEqual({ letterId: id, created: true });

    // The letter is in the archive; the key record has NOT moved.
    expect((await repo.getAddressKey(CORR))!.ed25519_public).toBe(corr.public.ed25519Public);

    // The change waits, and it names the letter that carried it.
    const offer = await repo.getKeyOffer(CORR);
    expect(offer).not.toBeNull();
    expect(offer!.letter_id).toBe(id);
    expect(offer!.ed25519_public).toBe(corrNext.public.ed25519Public);

    // And the address book shows it — including to whoever sealed to the OLD key.
    const book = await repo.listAddresses();
    expect(book.find((a) => a.id === CORR)!.keyOffer?.letterId).toBe(id);

    // The identity is still the handle: nothing about an offer is proof.
    expect(await repo.getIdentityId(CORR)).toBe(CORR);
  });

  it("only the address itself, or someone who can see the keyletter, may answer — the negative", async () => {
    const offer = await repo.getKeyOffer(CORR);
    expect(offer).not.toBeNull();

    // On the envelope: yes.
    expect(await mayAnswerKeyOffer(repo, YOU, CORR, offer!.letter_id)).toBe(true);
    // The address itself: yes, it may always answer its own change.
    expect(await mayAnswerKeyOffer(repo, CORR, CORR, offer!.letter_id)).toBe(true);
    // A resident who is not party to the letter: no. They learn nothing — the
    // route answers the same 404 as for an offer that does not exist.
    expect(await mayAnswerKeyOffer(repo, STRANGER, CORR, offer!.letter_id)).toBe(false);
    // A letter id that is not the offer's: no.
    expect(await mayAnswerKeyOffer(repo, YOU, CORR, "not-the-offer")).toBe(false);
  });

  it("accepting installs the offered keys — still keyletter origin, identity untouched", async () => {
    const offer = await repo.getKeyOffer(CORR);
    // What the route does on accept.
    await repo.setAddressKey(
      CORR,
      {
        ageRecipient: offer!.age_recipient,
        ed25519Public: offer!.ed25519_public,
        recoveryAgeRecipient: offer!.recovery_age_recipient,
      },
      "keyletter",
      offer!.letter_id,
    );
    await repo.resolveKeyOffer(CORR, "accepted");

    expect((await repo.getAddressKey(CORR))!.ed25519_public).toBe(corrNext.public.ed25519Public);

    const history = await repo.getAddressKeyHistory(CORR);
    expect(history).toHaveLength(2);
    expect(history.filter((r) => r.retired_at === null)).toHaveLength(1);
    expect(history[0].origin).toBe("keyletter");
    expect(history[0].source_letter_id).toBe(offer!.letter_id);
    // The old key is retired, not destroyed: letters sealed to it stay
    // verifiable, which is the whole reason `address_keys` is append-only.
    expect(history[1].ed25519_public).toBe(corr.public.ed25519Public);
    expect(history[1].retired_at).not.toBeNull();

    expect(await repo.getKeyOffer(CORR)).toBeNull();
    // And the accept did not move the identity spine.
    expect(await repo.getIdentityId(CORR)).toBe(CORR);
  });

  it("a registration with proof settles an offer and pins the identity at last", async () => {
    // A third key arrives by keyletter; the correspondent then registers the
    // SAME key with proof of possession. That registration is the first proven
    // one, so it pins — the case the 034 pin-gate exists for.
    const { letter } = await keyLetter(third.public, third.ed25519Private, {
      gregorian: "2026-11-08T16:00:00.000Z",
    });
    await pipeline.ingest(letter);
    expect(await repo.getKeyOffer(CORR)).not.toBeNull();

    await repo.setAddressKey(CORR, third.public);

    expect(await repo.getKeyOffer(CORR)).toBeNull();
    const { rows } = await db.pool.query<{ resolution: string }>(
      `SELECT resolution FROM address_key_offers WHERE address = $1 ORDER BY id DESC LIMIT 1`,
      [CORR],
    );
    expect(rows[0].resolution).toBe("accepted");
    // Now, and only now, the identity is the key.
    expect(await repo.getIdentityId(CORR)).toBe(third.public.ed25519Public);
  });

  it("a re-delivered keyletter is a duplicate — and re-asserts its effect idempotently", async () => {
    const { letter, id } = await keyLetter(third.public, third.ed25519Private, {
      gregorian: "2026-11-08T16:30:00.000Z",
    });
    expect(await pipeline.ingest(letter)).toEqual({ letterId: id, created: true });
    expect(await pipeline.ingest(letter)).toEqual({ letterId: id, created: false });
    // The live record already agrees, so no offer is raised and no history is
    // stacked: the effect is a function of the record, not of the delivery.
    expect(await repo.getKeyOffer(CORR)).toBeNull();
    const history = await repo.getAddressKeyHistory(CORR);
    expect(history.filter((r) => r.retired_at === null)).toHaveLength(1);
    expect(await applyKeyFrame(repo, noopLog as never, letter, id)).toBe("unchanged");
  });
});
