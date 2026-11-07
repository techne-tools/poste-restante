/**
 * Sealed payloads — SPEC §15, C1 of PLAN-crypto.md, integration (postgres).
 *
 * The property under test is a NEGATIVE, and it is the whole point of the
 * card: a sealed letter's enclosure is ciphertext, so the plaintext must
 * appear in NEITHER the object store NOR the catalog row. This suite writes
 * a real catalog row through the real repository, then reads both surfaces
 * back and looks for the plaintext.
 *
 * Also locked here:
 *   * the bytes are stored unchanged (the house moves opaque data);
 *   * plaintext → sealed letter is 422 against a real `letters.sealed` row;
 *   * sealed → unsealed letter is 422 the other way;
 *   * a non-participant gets 404 on list and download.
 *
 * Postgres only: the payload store is an in-memory double (the real one is
 * S3 and is exercised in test/unit/s3-store.test.ts). Gated by
 * POSTE_RESTANTE_INTEGRATION=1 like the rest of the integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connectDbAndMigrate, type Db } from "../../src/db/index.js";
import { PostgresRepository } from "../../src/db/repository.js";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import { createLetterServer } from "../../src/server.js";
import {
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
  type ResidentKeypair,
} from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import type { House } from "../../src/house.js";
import type { Letter, SealedLetterBody } from "../../src/types.js";
import type { PayloadStore, StoredPayload } from "../../src/minio/store.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5433/poste_restante_test";

type SealedLetter = Letter & { body: SealedLetterBody };

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

/** The plaintext the house must never see. Long and distinctive so a
 *  substring search over the stored bytes and the catalog row is decisive. */
const PLAINTEXT_MARKER =
  "REHEARSAL TAKE THREE — the storm cue moves to 47 — FOR NO EYES BUT THE PARTICIPANTS";

interface MemoryStore extends PayloadStore {
  objects: Map<string, Uint8Array>;
}

function memoryStore(): MemoryStore {
  const objects = new Map<string, Uint8Array>();
  const store: MemoryStore = {
    objects,
    put: async (letterId, name, data) => {
      const key = `letters/${letterId}/${name}`;
      objects.set(key, data);
      return key;
    },
    putStream: async (
      letterId: string,
      name: string,
      body: ReadableStream<Uint8Array>,
      _contentType?: string,
      _sizeHint?: number,
    ): Promise<StoredPayload> => {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      const key = `letters/${letterId}/${name}`;
      objects.set(key, bytes);
      return { key, size };
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
    listForLetter: async (letterId) =>
      Array.from(objects.keys()).filter((k) => k.startsWith(`letters/${letterId}/`)),
    deleteForLetter: async (letterId) => {
      for (const k of Array.from(objects.keys())) {
        if (k.startsWith(`letters/${letterId}/`)) objects.delete(k);
      }
    },
  };
  return store;
}

const auth = {
  authenticate: async (header?: string) => {
    const match = /^Bearer (\S+)$/.exec(header ?? "");
    return match ? { address: match[1], method: "password" } : null;
  },
} as never;

const bearer = (address: string) => ({ Authorization: `Bearer ${address}` });

describe.skipIf(!INTEGRATION)("sealed payloads (integration)", () => {
  let db: Db;
  let repo: PostgresRepository;
  let pipeline: IngestionPipeline;
  let store: MemoryStore;
  let app: ReturnType<typeof createLetterServer>;

  let keys: ResidentKeypair;
  let sealed: SealedLetter;
  let sealedId: string;
  let plainId: string;

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
      `TRUNCATE letter_payloads, invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys
       RESTART IDENTITY CASCADE`,
    );
    await db.pool.query(
      `INSERT INTO addresses (id, identity_id) VALUES
         ('you@house', 'you@house'),
         ('intruder@house', 'intruder@house')`,
    );

    keys = await generateResidentKeypair("you@house");
    await repo.setAddressKey("you@house", keys.public);

    // A sealed letter to the sender — a real row with `letters.sealed = true`.
    const content = await sealToRecipients("the storm is coming — sealed", [keys.public.ageRecipient]);
    const identities = new Map([["you@house", keys.public.ed25519Public]]);
    const letter: SealedLetter = {
      envelope: { from: "you@house", to: ["you@house"], cc: [], thread: "th_sealed_payloads", kind: "letter", lang: "en-AU", subject: "" },
      time: { gregorian: "2026-11-08T10:00:00Z", frames: [] },
      body: { format: "sealed", content, recipients: [keys.public.ageRecipient], signature: "" },
    };
    sealedId = letterIdFromCanonical(canonicaliseWith(letter, identities));
    letter.body.signature = signLetterId(sealedId, keys.ed25519Private);
    const ingested = await pipeline.ingest(letter);
    expect(ingested).toEqual({ letterId: sealedId, created: true });
    sealed = letter;

    // An unsealed letter from the same writer — the other mismatch direction.
    const plain: Letter = {
      envelope: { from: "you@house", to: ["you@house"], cc: [], thread: "th_open_payloads", kind: "letter", lang: "en-AU", subject: "open" },
      time: { gregorian: "2026-11-08T10:05:00Z", frames: [] },
      body: { format: "markdown", content: "an open letter" },
    };
    const plainIngested = await pipeline.ingest(plain);
    plainId = plainIngested.letterId;
    expect(plainIngested.created).toBe(true);

    store = memoryStore();
    const house = {
      config: { whisperUrl: undefined, payloadMaxBytes: 64 * 1024 * 1024 },
      repo,
      payloads: store,
      log: noopLog,
      audio: { transcribeAudioLetter: async () => undefined },
    } as unknown as House;
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stores a sealed enclosure as ciphertext the plaintext cannot be found in", async () => {
    const ciphertext = new TextEncoder().encode(
      await sealToRecipients(PLAINTEXT_MARKER, [keys.public.ageRecipient]),
    );

    const res = await app.request(`/v1/letters/${sealedId}/payloads`, {
      method: "POST",
      headers: {
        ...bearer("you@house"),
        "X-Payload-Name": "take-3.age",
        "Content-Type": "application/octet-stream",
        "X-Payload-Sealed": "1",
        "Content-Length": String(ciphertext.byteLength),
      },
      body: ciphertext,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sealed).toBe(true);
    expect(body.size).toBe(ciphertext.byteLength);

    // 1. The raw object in the store: byte-identical to what was uploaded,
    //    and the plaintext appears nowhere in it.
    const stored = store.objects.get(`letters/${sealedId}/take-3.age`);
    expect(stored).toEqual(ciphertext);
    expect(new TextDecoder().decode(stored!)).not.toContain("REHEARSAL TAKE THREE");
    expect(new TextDecoder().decode(stored!)).not.toContain("the storm cue");

    // 2. The catalog row, read straight from postgres: the seal is true,
    //    the type is octet-stream, and the row carries no content.
    const { rows } = await db.pool.query(
      `SELECT letter_id, name, content_type, size, sealed FROM letter_payloads WHERE letter_id = $1`,
      [sealedId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      letter_id: sealedId,
      name: "take-3.age",
      content_type: "application/octet-stream",
      // bigint: postgres reports it as a string; the repository coerces for
      // the API, but this is the raw row.
      size: String(ciphertext.byteLength),
      sealed: true,
    });
    expect(JSON.stringify(rows[0])).not.toContain("REHEARSAL TAKE THREE");
  });

  it("lists and serves the sealed enclosure as ciphertext", async () => {
    const list = await app.request(`/v1/letters/${sealedId}/payloads`, {
      headers: bearer("you@house"),
    });
    expect(list.status).toBe(200);
    const listing = await list.json();
    expect(listing.payloads).toEqual([
      {
        key: `letters/${sealedId}/take-3.age`,
        name: "take-3.age",
        contentType: "application/octet-stream",
        size: store.objects.get(`letters/${sealedId}/take-3.age`)!.byteLength,
        sealed: true,
      },
    ]);

    const download = await app.request(`/v1/letters/${sealedId}/payloads/take-3.age`, {
      headers: bearer("you@house"),
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("X-Payload-Sealed")).toBe("1");
    expect(download.headers.get("Content-Type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes).toEqual(store.objects.get(`letters/${sealedId}/take-3.age`));
  });

  it("refuses plaintext against the real sealed row — 422, nothing stored", async () => {
    const before = store.objects.size;
    const res = await app.request(`/v1/letters/${sealedId}/payloads`, {
      method: "POST",
      headers: {
        ...bearer("you@house"),
        "X-Payload-Name": "leak.wav",
        "Content-Type": "audio/wav",
      },
      body: new TextEncoder().encode("plaintext on a sealed letter"),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("payload_seal_mismatch");
    expect(store.objects.size).toBe(before);

    const { rows } = await db.pool.query(
      `SELECT 1 FROM letter_payloads WHERE letter_id = $1 AND name = 'leak.wav'`,
      [sealedId],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a sealed enclosure against the real unsealed row — 422", async () => {
    const res = await app.request(`/v1/letters/${plainId}/payloads`, {
      method: "POST",
      headers: {
        ...bearer("you@house"),
        "X-Payload-Name": "take-3.age",
        "Content-Type": "application/octet-stream",
        "X-Payload-Sealed": "1",
      },
      body: new TextEncoder().encode("age-ciphertext"),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("payload_seal_mismatch");
  });

  it("gives a non-participant 404 on list and download, and never 403", async () => {
    const list = await app.request(`/v1/letters/${sealedId}/payloads`, {
      headers: bearer("intruder@house"),
    });
    expect(list.status).toBe(404);

    const download = await app.request(`/v1/letters/${sealedId}/payloads/take-3.age`, {
      headers: bearer("intruder@house"),
    });
    expect(download.status).toBe(404);

    // Unauthenticated is 401, not a leak of existence.
    const anon = await app.request(`/v1/letters/${sealedId}/payloads`);
    expect(anon.status).toBe(401);
  });

  it("keeps the letter body's own seal intact — the payload work touched nothing", async () => {
    const row = await repo.getLetter(sealedId);
    expect(row!.sealed).toBe(true);
    expect(row!.body).toBe(sealed.body.content);
    expect(row!.body_text).toBe("");
  });
});
