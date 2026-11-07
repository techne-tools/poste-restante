/**
 * The ingestion pipeline — hermetic unit tests (PLAN-crypto.md E2/E3).
 *
 * Two claims are tested here, both about SHAPE rather than behaviour:
 *
 *   E2  the identity map is resolved with ONE query for the whole handle
 *       set — the per-handle lookup is a regression, not a slow path;
 *   E3  a sealed letter cannot reach the embedder or the semantic store,
 *       because the only method that does is typed for an OpenLetter. The
 *       test proves the runtime consequence (no embed, no upsert, empty
 *       bodyText); the compiler proves the branch cannot exist.
 *
 * Plus the observation this sweep added: a sealed letter whose signature was
 * made by a key the sender has since RETIRED is accepted (the archive's past
 * re-delivering) and said out loud in the log, by letter id only.
 *
 * No postgres, no qdrant, no ollama: the repo/semantic/embedder are stubs.
 */
import { describe, it, expect } from "vitest";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import { generateEd25519Keypair, signLetterId } from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import type { Letter, StoredLetter } from "../../src/types.js";

interface Logged {
  level: "info" | "warn" | "error";
  event: string;
  fields?: Record<string, unknown>;
}

/** A house that records what was asked of it and holds no database. */
function fakeHouse(liveKeys: Map<string, string>, history: Map<string, string[]> = new Map()) {
  const stored: StoredLetter[] = [];
  const events: Logged[] = [];
  const batchCalls: string[][] = [];
  const perHandleCalls: string[] = [];
  const upserts: string[] = [];
  const embeddings: string[] = [];

  const repo = {
    getLetter: async () => null,
    storeLetter: async (letter: StoredLetter) => {
      stored.push(letter);
    },
    getAddressKeys: async (addresses: string[]) => {
      batchCalls.push(addresses);
      const resolved = new Map<string, string>();
      for (const address of addresses) {
        const key = liveKeys.get(address);
        if (key) resolved.set(address, key);
      }
      return resolved;
    },
    getAddressKey: async (address: string) => {
      perHandleCalls.push(address);
      return null;
    },
    // The DURABLE identity map — what the pinned resolver reads. In these
    // pipeline tests the live-key map stands in for it: the point under test
    // is which handles are resolved and in how many queries, not the pin.
    getIdentityIds: async (addresses: string[]) => {
      batchCalls.push(addresses);
      const resolved = new Map<string, string>();
      for (const address of addresses) {
        const key = liveKeys.get(address);
        if (key) resolved.set(address, key);
      }
      return resolved;
    },
    getAddressKeyHistory: async (address: string) =>
      (history.get(address) ?? (liveKeys.has(address) ? [liveKeys.get(address)!] : [])).map(
        (ed25519_public) => ({ ed25519_public }),
      ),
  };
  const semantic = {
    upsert: async (id: string) => {
      upserts.push(id);
    },
    delete: async () => {},
  };
  const embedder = {
    embed: async (text: string) => {
      embeddings.push(text);
      return [0.25, 0.5];
    },
  };
  const log = {
    info: (event: string, fields?: Record<string, unknown>) => events.push({ level: "info", event, fields }),
    warn: (event: string, fields?: Record<string, unknown>) => events.push({ level: "warn", event, fields }),
    error: (event: string, fields?: Record<string, unknown>) => events.push({ level: "error", event, fields }),
  };

  const pipeline = new IngestionPipeline(
    repo as never,
    semantic as never,
    embedder as never,
    undefined,
    log,
  );

  return {
    pipeline,
    stored,
    events,
    batchCalls,
    perHandleCalls,
    upserts,
    embeddings,
  };
}

function envelope(from: string, to: string[], cc: string[] = []) {
  return { from, to, cc, thread: "th_1", kind: "letter" as const, lang: "en-AU", subject: "" };
}

function baseLetter(from: string, to: string[]): Letter {
  return {
    envelope: envelope(from, to),
    time: { gregorian: "2026-02-01T09:00:00.000Z", frames: [] },
    body: { format: "markdown", content: "# hello\n\nthis is the body" },
  };
}

/** Seal-shape body, signed over the id IT resolves to under `signingKey` —
 *  the id hashes the stored (sealed) body, not the draft's markdown. */
function sealedLetter(
  letter: Letter,
  identities: Map<string, string>,
  signingKey: { publicKey: string; privateKey: string },
): Letter {
  const sealed: Letter = {
    ...letter,
    body: {
      format: "sealed",
      content: "-----BEGIN AGE ENCRYPTED FILE-----\nciphertext\n-----END AGE ENCRYPTED FILE-----",
      recipients: ["age1sealed"],
      signature: "",
    },
  };
  const identitiesForSigner = new Map(identities);
  identitiesForSigner.set(letter.envelope.from, signingKey.publicKey);
  const id = letterIdFromCanonical(canonicaliseWith(sealed, identitiesForSigner));
  return { ...sealed, body: { ...sealed.body, signature: signLetterId(id, signingKey.privateKey) } };
}

describe("pipeline: the sealed path is typed, not skipped", () => {
  it("stores a sealed letter without reading it or indexing it", async () => {
    const keys = generateEd25519Keypair();
    const identities = new Map([["ada@house", keys.publicKey]]);
    const letter = sealedLetter(baseLetter("ada@house", ["bo@house"]), identities, keys);
    const house = fakeHouse(identities);

    const result = await house.pipeline.ingest(letter);

    expect(result).toEqual({ letterId: expect.any(String), created: true });
    expect(house.embeddings).toEqual([]);
    expect(house.upserts).toEqual([]);
    expect(house.stored).toHaveLength(1);
    expect(house.stored[0].bodyText).toBe("");
    expect(house.events.map((e) => e.event)).toContain("ingest:sealed-not-indexed");
    expect(house.events.find((e) => e.event === "ingest:stored")?.fields).toEqual({
      letterId: result.letterId,
      sealed: true,
    });
  });

  it("indexes an open letter, and says it was not sealed", async () => {
    const house = fakeHouse(new Map());
    const result = await house.pipeline.ingest(baseLetter("ada@house", ["bo@house"]));

    expect(result.created).toBe(true);
    expect(house.embeddings).toHaveLength(1);
    expect(house.embeddings[0]).toContain("this is the body");
    expect(house.upserts).toEqual([result.letterId]);
    expect(house.stored[0].bodyText).toContain("this is the body");
    expect(house.events.find((e) => e.event === "ingest:stored")?.fields).toEqual({
      letterId: result.letterId,
      sealed: false,
    });
  });

  it("accepts a re-delivered letter signed by a retired key, and logs the generation", async () => {
    const old = generateEd25519Keypair();
    const current = generateEd25519Keypair();
    const identities = new Map([["ada@house", current.publicKey]]);
    // Signed before the rotation: the id is the OLD key's resolution.
    const letter = sealedLetter(baseLetter("ada@house", ["bo@house"]), identities, old);
    const house = fakeHouse(identities, new Map([["ada@house", [current.publicKey, old.publicKey]]]));

    const result = await house.pipeline.ingest(letter);

    expect(result.created).toBe(true);
    expect(house.events.map((e) => e.event)).toContain("ingest:sealed-signed-by-retired-key");
    // The event names the letter, never the address (privacy checklist #6).
    const retiredEvent = house.events.find((e) => e.event === "ingest:sealed-signed-by-retired-key");
    expect(Object.keys(retiredEvent?.fields ?? {})).toEqual(["letterId"]);
  });

  it("does not log a retired-key event for a letter the current key signed", async () => {
    const current = generateEd25519Keypair();
    const identities = new Map([["ada@house", current.publicKey]]);
    const letter = sealedLetter(baseLetter("ada@house", ["bo@house"]), identities, current);
    const house = fakeHouse(identities);

    await house.pipeline.ingest(letter);

    expect(house.events.map((e) => e.event)).not.toContain("ingest:sealed-signed-by-retired-key");
  });
});

describe("pipeline: the identity map costs one query per letter", () => {
  it("resolves from, to and cc in a single batched lookup, never per handle", async () => {
    const house = fakeHouse(new Map());
    const letter: Letter = {
      envelope: envelope("ada@house", ["bo@house", "cy@house"], ["dee@house"]),
      time: { gregorian: "2026-02-01T09:00:00.000Z", frames: [] },
      body: { format: "markdown", content: "hello" },
    };

    await house.pipeline.ingest(letter);

    expect(house.batchCalls).toHaveLength(1);
    // Every handle, deduplicated, in one call.
    expect([...house.batchCalls[0]].sort()).toEqual([
      "ada@house",
      "bo@house",
      "cy@house",
      "dee@house",
    ]);
    // The per-handle path is gone: a regression here is an N+1, not a style
    // choice (PLAN-crypto.md E2).
    expect(house.perHandleCalls).toEqual([]);
  });

  it("deduplicates a handle that is both sender and recipient", async () => {
    const house = fakeHouse(new Map());
    const letter: Letter = {
      envelope: envelope("ada@house", ["ada@house", "bo@house"]),
      time: { gregorian: "2026-02-01T09:00:00.000Z", frames: [] },
      body: { format: "markdown", content: "to myself" },
    };

    await house.pipeline.ingest(letter);

    expect(house.batchCalls[0].filter((h) => h === "ada@house")).toHaveLength(1);
  });
});
