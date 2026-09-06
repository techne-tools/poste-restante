import { describe, it, expect } from "vitest";
import { createLetterServer } from "../../src/server.js";
import type { House } from "../../src/house.js";
import type { Letter } from "../../src/types.js";
import type { PayloadStore } from "../../src/minio/store.js";

function fakeHouseWithPayloads(): { house: House; payloadStore: PayloadStore } {
  const letters = new Map<string, Letter & { receivedAt: Date }>();
  const payloadMap = new Map<string, Uint8Array>();

  const payloadStore: PayloadStore = {
    put: async (letterId, name, data) => {
      const key = `letters/${letterId}/${name}`;
      payloadMap.set(key, data);
      return key;
    },
    get: async (key) => payloadMap.get(key) ?? null,
    delete: async (key) => {
      payloadMap.delete(key);
    },
    listForLetter: async (letterId) => {
      const prefix = `letters/${letterId}/`;
      return Array.from(payloadMap.keys()).filter((k) => k.startsWith(prefix));
    },
    deleteForLetter: async (letterId) => {
      const prefix = `letters/${letterId}/`;
      for (const k of Array.from(payloadMap.keys())) {
        if (k.startsWith(prefix)) payloadMap.delete(k);
      }
    },
  };

  const sampleLetter: Letter = {
    id: "let_audio_123",
    envelope: {
      from: "you@house",
      to: ["hermes@house"],
      cc: [],
      thread: "th_audio",
      kind: "audio",
      lang: "en-AU",
      subject: "rehearsal memo",
    },
    time: {
      gregorian: "2026-09-06T12:00:00Z",
      frames: [{ frame: "season", value: "spring" }],
    },
    body: {
      format: "markdown",
      content: "audio recording",
    },
  };
  letters.set(sampleLetter.id!, { ...sampleLetter, receivedAt: new Date() });

  const house = {
    config: { whisperUrl: undefined } as never,
    db: {} as never,
    semantic: {} as never,
    embedder: {} as never,
    payloads: payloadStore,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    repo: {
      getLetter: async (id: string) => {
        const l = letters.get(id);
        if (!l) return null;
        return {
          id,
          from_addr: l.envelope.from,
          to_addrs: l.envelope.to,
          cc_addrs: l.envelope.cc,
          thread_id: l.envelope.thread,
          kind: l.envelope.kind,
          lang: l.envelope.lang,
          subject: l.envelope.subject,
          received_at: l.receivedAt,
          body_format: l.body.format,
          body_content: l.body.content,
          body_text: l.body.content,
          frames: l.time.frames,
        };
      },
      participationStates: async () => new Map(),
    } as never,
    pipeline: {
      delete: async (id: string) => {
        letters.delete(id);
        await payloadStore.deleteForLetter(id);
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

  return { house, payloadStore };
}

describe("Payloads API", () => {
  it("allows participant to upload, list, download, and delete raw payloads", async () => {
    const { house } = fakeHouseWithPayloads();
    const server = createLetterServer(house);

    // 1. Upload a payload
    const uploadRes = await server.request("/v1/letters/let_audio_123/payloads", {
      method: "POST",
      headers: {
        "X-Postal-Auth": "alice@house",
        "X-Payload-Name": "memo.wav",
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = await uploadRes.json();
    expect(uploaded.key).toBe("letters/let_audio_123/memo.wav");
    expect(uploaded.size).toBe(5);

    // 2. List payloads
    const listRes = await server.request("/v1/letters/let_audio_123/payloads", {
      headers: { "X-Postal-Auth": "bob@house" },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.payloads).toEqual([
      { key: "letters/let_audio_123/memo.wav", name: "memo.wav" },
    ]);

    // 3. Download payload
    const getRes = await server.request("/v1/letters/let_audio_123/payloads/memo.wav", {
      headers: { "X-Postal-Auth": "alice@house" },
    });
    expect(getRes.status).toBe(200);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    // 4. Delete payload
    const delRes = await server.request("/v1/letters/let_audio_123/payloads/memo.wav", {
      method: "DELETE",
      headers: { "X-Postal-Auth": "alice@house" },
    });
    expect(delRes.status).toBe(200);

    // 5. Verify gone
    const getAgain = await server.request("/v1/letters/let_audio_123/payloads/memo.wav", {
      headers: { "X-Postal-Auth": "alice@house" },
    });
    expect(getAgain.status).toBe(404);
  });

  it("fails closed (404) for non-participant", async () => {
    const { house } = fakeHouseWithPayloads();
    // Seed private letter between alice and bob (caller you@house is not party)
    const server = createLetterServer(house);

    const res = await server.request("/v1/letters/let_other_secret/payloads");
    expect(res.status).toBe(404);
  });
});
