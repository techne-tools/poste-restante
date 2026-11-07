/**
 * The payloads API — enclosures, and now the seal on them (031).
 *
 * The leak this suite closes: a sealed letter's body was ciphertext, its
 * enclosures were not. The route had no sealed branch and the object store
 * does no encryption, so any participant could attach raw bytes to a
 * sealed letter and the house could read them.
 *
 * Locked here:
 *   * a sealed upload to a sealed letter is stored and catalogued as
 *     octet-stream, `sealed = true`, bytes unchanged;
 *   * plaintext → sealed letter is 422, sealed → unsealed letter is 422
 *     (either direction leaks, so both are refused);
 *   * a sealed enclosure cannot arrive wrapped in multipart (the envelope
 *     is plaintext metadata);
 *   * a non-participant gets 404 on list, download and upload;
 *   * the upload streams — the catalog's size is what the store wrote;
 *   * no decryption path exists on the server side of an enclosure.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createLetterServer } from "../../src/server.js";
import type { House } from "../../src/house.js";
import type { Letter } from "../../src/types.js";
import type { PayloadStore, StoredPayload } from "../../src/minio/store.js";

interface CatalogRow {
  name: string;
  content_type: string;
  size: number;
  sealed: boolean;
}

interface FakeStore extends PayloadStore {
  objects: Map<string, Uint8Array>;
  lastHint: number | undefined;
  lastContentType: string | undefined;
}

function fakeHouse(seed: { letter: Letter; sealed: boolean }[]): {
  house: House;
  store: FakeStore;
  catalog: Map<string, CatalogRow[]>;
} {
  const letters = new Map<string, { letter: Letter; sealed: boolean }>();
  for (const s of seed) letters.set(s.letter.id!, s);
  const catalog = new Map<string, CatalogRow[]>();
  const objects = new Map<string, Uint8Array>();

  const store: FakeStore = {
    objects,
    lastHint: undefined,
    lastContentType: undefined,
    put: async (letterId, name, data) => {
      const key = `letters/${letterId}/${name}`;
      objects.set(key, data);
      return key;
    },
    putStream: async (
      letterId: string,
      name: string,
      body: ReadableStream<Uint8Array>,
      contentType?: string,
      sizeHint?: number,
    ): Promise<StoredPayload> => {
      store.lastHint = sizeHint;
      store.lastContentType = contentType;
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
    listForLetter: async (letterId) => {
      const prefix = `letters/${letterId}/`;
      return Array.from(objects.keys()).filter((k) => k.startsWith(prefix));
    },
    deleteForLetter: async (letterId) => {
      const prefix = `letters/${letterId}/`;
      for (const k of Array.from(objects.keys())) {
        if (k.startsWith(prefix)) objects.delete(k);
      }
      catalog.delete(letterId);
    },
  };

  const house = {
    config: { whisperUrl: undefined, payloadMaxBytes: 8 * 1024 * 1024 } as never,
    db: {} as never,
    semantic: {} as never,
    embedder: {} as never,
    payloads: store,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    repo: {
      getLetter: async (id: string) => {
        const entry = letters.get(id);
        if (!entry) return null;
        const l = entry.letter;
        return {
          id,
          from_addr: l.envelope.from,
          to_addrs: l.envelope.to,
          cc_addrs: l.envelope.cc,
          thread_id: l.envelope.thread,
          kind: l.envelope.kind,
          lang: l.envelope.lang,
          subject: l.envelope.subject,
          received_at: new Date(),
          body_format: l.body.format,
          body_content: l.body.content,
          body_text: l.body.content,
          frames: l.time.frames,
          sealed: entry.sealed,
        };
      },
      participationStates: async () => new Map(),
      getPayload: async (letterId: string, name: string) =>
        catalog.get(letterId)?.find((p) => p.name === name) ?? null,
      listPayloads: async (letterId: string) => catalog.get(letterId) ?? [],
      insertPayload: async (
        letterId: string,
        name: string,
        content_type: string,
        size: number,
        sealed = false,
      ) => {
        const list = catalog.get(letterId) ?? [];
        const existing = list.findIndex((p) => p.name === name);
        const row: CatalogRow = { name, content_type, size, sealed };
        if (existing >= 0) list[existing] = row;
        else list.push(row);
        catalog.set(letterId, list);
      },
      deletePayload: async (letterId: string, name: string) => {
        const list = catalog.get(letterId) ?? [];
        catalog.set(
          letterId,
          list.filter((p) => p.name !== name),
        );
      },
    } as never,
    pipeline: {
      delete: async (id: string) => {
        letters.delete(id);
        await store.deleteForLetter(id);
        return true;
      },
    } as never,
    retrieval: {} as never,
    whisper: {} as never,
    participation: {} as never,
    book: {} as never,
    outbound: null,
    mailbox: null,
    queue: {} as never,
    eventBus: {} as never,
    audio: {} as never,
    transcriber: {} as never,
    close: async () => {},
  } as unknown as House;

  return { house, store, catalog };
}

/** Residents are whoever the bearer token names. A null header is nobody. */
const auth = {
  authenticate: async (header?: string) => {
    const match = /^Bearer (\S+)$/.exec(header ?? "");
    return match ? { address: match[1], method: "password" } : null;
  },
} as never;

const bearer = (address: string) => ({ Authorization: `Bearer ${address}` });

function plainLetter(over: Partial<Letter> = {}): Letter {
  return {
    id: "let_plain_1",
    envelope: {
      from: "alice@house",
      to: ["bob@house"],
      cc: [],
      thread: "th_plain",
      kind: "audio",
      lang: "en-AU",
      subject: "rehearsal memo",
    },
    time: { gregorian: "2026-11-08T12:00:00Z", frames: [{ frame: "season", value: "spring" }] },
    body: { format: "markdown", content: "audio recording" },
    ...over,
  };
}

function sealedLetter(over: Partial<Letter> = {}): Letter {
  return plainLetter({
    id: "let_sealed_1",
    envelope: {
      from: "alice@house",
      to: ["bob@house"],
      cc: [],
      thread: "th_sealed",
      kind: "letter",
      lang: "en-AU",
      subject: "",
    },
    body: {
      format: "sealed",
      content: "-----BEGIN AGE ENCRYPTED FILE-----\nciphertext\n-----END AGE ENCRYPTED FILE-----",
      recipients: ["age1recipient"],
      signature: "sig",
    },
    ...over,
  });
}

function server(house: House) {
  return createLetterServer(house, { auth });
}

describe("Payloads API — the seal travels with the enclosure", () => {
  it("stores a sealed enclosure as ciphertext and never parses it", async () => {
    const { house, store, catalog } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    const app = server(house);
    const ciphertext = new TextEncoder().encode("age-ciphertext-bytes-not-plaintext");

    const res = await app.request("/v1/letters/let_sealed_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "take-3.age",
        "Content-Type": "application/octet-stream",
        "X-Payload-Sealed": "1",
        // A real upload carries the length; `app.request` does not add it.
        "Content-Length": String(ciphertext.byteLength),
      },
      body: ciphertext,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      key: "letters/let_sealed_1/take-3.age",
      name: "take-3.age",
      size: ciphertext.byteLength,
      sealed: true,
    });

    // The bytes in the store are EXACTLY what arrived — no re-encoding, no
    // re-sealing, no stripping. The house moved opaque data.
    expect(store.objects.get("letters/let_sealed_1/take-3.age")).toEqual(ciphertext);
    // The client declared the length, so the store took the direct path.
    expect(store.lastHint).toBe(ciphertext.byteLength);
    expect(store.lastContentType).toBe("application/octet-stream");

    // The catalog carries the pointer and the seal, never the content.
    expect(catalog.get("let_sealed_1")).toEqual([
      { name: "take-3.age", content_type: "application/octet-stream", size: ciphertext.byteLength, sealed: true },
    ]);
  });

  it("lists a sealed enclosure as sealed, with its name and size only", async () => {
    const { house, catalog } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    catalog.set("let_sealed_1", [
      { name: "take-3.age", content_type: "application/octet-stream", size: 31, sealed: true },
    ]);
    const app = server(house);

    const res = await app.request("/v1/letters/let_sealed_1/payloads", {
      headers: bearer("bob@house"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payloads).toEqual([
      {
        key: "letters/let_sealed_1/take-3.age",
        name: "take-3.age",
        contentType: "application/octet-stream",
        size: 31,
        sealed: true,
      },
    ]);
  });

  it("serves a sealed enclosure as unchanged ciphertext, marked sealed", async () => {
    const { house, catalog } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    (house.payloads as unknown as FakeStore).objects.set("letters/let_sealed_1/take-3.age", bytes);
    catalog.set("let_sealed_1", [
      { name: "take-3.age", content_type: "application/octet-stream", size: bytes.byteLength, sealed: true },
    ]);
    const app = server(house);

    const res = await app.request("/v1/letters/let_sealed_1/payloads/take-3.age", {
      headers: bearer("alice@house"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Payload-Sealed")).toBe("1");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("refuses plaintext on a sealed letter — 422, nothing stored", async () => {
    const { house, store, catalog } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    const app = server(house);

    const res = await app.request("/v1/letters/let_sealed_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "leak.wav",
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("payload_seal_mismatch");
    expect(store.objects.size).toBe(0);
    expect(catalog.size).toBe(0);
  });

  it("refuses a sealed enclosure on an unsealed letter — 422, nothing stored", async () => {
    const { house, store, catalog } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    const app = server(house);

    const res = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "take-3.age",
        "Content-Type": "application/octet-stream",
        "X-Payload-Sealed": "1",
      },
      body: new Uint8Array([9, 9, 9]),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("payload_seal_mismatch");
    expect(store.objects.size).toBe(0);
    expect(catalog.size).toBe(0);
  });

  it("refuses a sealed enclosure wrapped in multipart", async () => {
    const { house } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    const app = server(house);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([7, 7])], "take-3.age"));

    const res = await app.request("/v1/letters/let_sealed_1/payloads", {
      method: "POST",
      headers: { ...bearer("alice@house"), "X-Payload-Sealed": "1" },
      body: form,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("sealed_payload_requires_raw_body");
  });

  it("allows a participant to upload, list, download and delete a plain enclosure", async () => {
    const { house } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    const app = server(house);

    const uploadRes = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "memo.wav",
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = await uploadRes.json();
    expect(uploaded.key).toBe("letters/let_plain_1/memo.wav");
    expect(uploaded.size).toBe(5);
    expect(uploaded.sealed).toBe(false);

    const listRes = await app.request("/v1/letters/let_plain_1/payloads", {
      headers: bearer("bob@house"),
    });
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).payloads).toEqual([
      {
        key: "letters/let_plain_1/memo.wav",
        name: "memo.wav",
        contentType: "audio/wav",
        size: 5,
        sealed: false,
      },
    ]);

    const getRes = await app.request("/v1/letters/let_plain_1/payloads/memo.wav", {
      headers: bearer("alice@house"),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toBe("audio/wav");
    expect(getRes.headers.get("X-Payload-Sealed")).toBeNull();
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    const delRes = await app.request("/v1/letters/let_plain_1/payloads/memo.wav", {
      method: "DELETE",
      headers: bearer("alice@house"),
    });
    expect(delRes.status).toBe(200);

    const getAgain = await app.request("/v1/letters/let_plain_1/payloads/memo.wav", {
      headers: bearer("alice@house"),
    });
    expect(getAgain.status).toBe(404);
    const listAfter = await app.request("/v1/letters/let_plain_1/payloads", {
      headers: bearer("bob@house"),
    });
    expect((await listAfter.json()).payloads).toEqual([]);
  });

  it("returns 400 for an empty body", async () => {
    const { house } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    const app = server(house);
    const res = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: { ...bearer("alice@house"), "X-Payload-Name": "nothing.bin" },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("empty_payload");
  });

  it("refuses an enclosure over the payload cap — 413", async () => {
    const { house } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    (house.config as { payloadMaxBytes: number }).payloadMaxBytes = 4;
    const app = server(house);
    const res = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: { ...bearer("alice@house"), "X-Payload-Name": "big.bin" },
      body: new Uint8Array([1, 2, 3, 4, 5, 6]),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  });

  it("fails closed (404) for a non-participant on list, download and upload", async () => {
    const { house, store } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    store.objects.set("letters/let_sealed_1/take-3.age", new Uint8Array([1, 2, 3]));
    const app = server(house);

    const list = await app.request("/v1/letters/let_sealed_1/payloads", {
      headers: bearer("carol@house"),
    });
    expect(list.status).toBe(404);

    const download = await app.request("/v1/letters/let_sealed_1/payloads/take-3.age", {
      headers: bearer("carol@house"),
    });
    expect(download.status).toBe(404);

    const upload = await app.request("/v1/letters/let_sealed_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("carol@house"),
        "X-Payload-Name": "intruder.age",
        "X-Payload-Sealed": "1",
      },
      body: new Uint8Array([4, 5]),
    });
    expect(upload.status).toBe(404);

    // Nothing arrived, and nothing was revealed: 404, never 403.
    expect(store.objects.has("letters/let_sealed_1/intruder.age")).toBe(false);
  });

  it("accepts an enclosure larger than the mail body limit — the route streams past it", async () => {
    // 30 MiB is `bodyLimit`'s ceiling for a letter. An enclosure that big
    // must reach the store, not 413: the route is exempt from the mail limit
    // and enforces its own while streaming (E1).
    const { house } = fakeHouse([{ letter: sealedLetter(), sealed: true }]);
    // Above the mail limit, below this house's payload cap: only the bypass
    // can let it through.
    (house.config as { payloadMaxBytes: number }).payloadMaxBytes = 64 * 1024 * 1024;
    const app = server(house);
    const big = new Uint8Array(31 * 1024 * 1024);

    const res = await app.request("/v1/letters/let_sealed_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "long-rehearsal.age",
        "Content-Type": "application/octet-stream",
        "X-Payload-Sealed": "1",
        "Content-Length": String(big.byteLength),
      },
      body: big,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).size).toBe(big.byteLength);
  });

  it("returns 503 when the house has nowhere to keep the enclosure", async () => {
    const { house } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    (house as { payloads?: unknown }).payloads = undefined;
    const app = server(house);
    const res = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: { ...bearer("alice@house"), "X-Payload-Name": "nowhere.bin" },
      body: new Uint8Array([1, 2]),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("payload_store_unavailable");
  });

  it("rolls back the object when the catalog insert fails — no orphaned bytes", async () => {
    const { house, store } = fakeHouse([{ letter: plainLetter(), sealed: false }]);
    (house as { repo: unknown }).repo = {
      ...(house.repo as object),
      insertPayload: async () => {
        throw new Error("catalog is closed");
      },
    };
    const app = server(house);

    const res = await app.request("/v1/letters/let_plain_1/payloads", {
      method: "POST",
      headers: {
        ...bearer("alice@house"),
        "X-Payload-Name": "orphan.bin",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array([9, 9]),
    });
    expect(res.status).toBe(500);
    expect(await store.listForLetter("let_plain_1")).toEqual([]);
  });
});

describe("the house holds no key to an enclosure", () => {
  /** The server-side half of the promise: not a flag, not a fallback — no
   *  decryption path at all. If someone adds one, this fails first. */
  it("routes, store and catalog contain no decrypt call and no age import", () => {
    const files = [
      new URL("../../src/routes/payloads.ts", import.meta.url),
      new URL("../../src/minio/store.ts", import.meta.url),
      new URL("../../src/minio/s3-store.ts", import.meta.url),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']age-encryption["']/);
      expect(source).not.toMatch(/new\s+Decrypter\s*\(/);
      expect(source).not.toMatch(/\.decrypt\s*\(/);
    }
  });

  it("the migration adds the seal as a column, not a runtime flag", () => {
    const sql = readFileSync(
      new URL("../../src/db/migrations/031_sealed_payloads.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS sealed boolean NOT NULL DEFAULT false");
  });
});
