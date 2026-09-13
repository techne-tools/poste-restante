/**
 * Client crypto — SPEC §15, unit tests.
 *
 * The client's letter id MUST be byte-identical to the server's
 * (id.ts::canonicaliseWith + letterIdFromCanonical): the signature gate
 * rejects any letter whose id does not match the server's re-derivation.
 * These tests lock the canonical form to the known server fixture, and
 * prove seal/unseal round-trips with the client-held keypair.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  canonicalise,
  letterIdFromCanonical,
  generateKeys,
  ensureKeys,
  mintRecoveryIdentity,
  sealToRecipients,
  unsealWithIdentity,
  unsealLetterBody,
  sealDraft,
} from "./crypto";

/** The localStorage the keystore writes to. */
const KEYSTORE = (globalThis as unknown as { localStorage?: Storage }).localStorage;

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("canonicalise — the exact mirror of the server's letter id", () => {
  it("produces the known canonical form for a keyed letter", () => {
    const identities = new Map([
      ["chris@house", "ed25519_pub_1"],
      ["hermes@house", "ed25519_pub_2"],
    ]);
    const letter = {
      envelope: {
        from: "chris@house",
        to: ["hermes@house"],
        cc: [],
        thread: "th_9f2c1",
        kind: "letter",
        lang: "en-AU",
        subject: "re: the plural-time archive",
      },
      time: {
        gregorian: "2026-08-29T14:00:00+04:00",
        frames: [{ frame: "season", value: "autumn" }],
      },
      body: { format: "sealed", content: "age1ciphertext-armored" },
    };
    const canonical = canonicalise(letter, identities);
    // The server's canonicaliseWith emits exactly this JSON — field
    // order fixed, addresses resolved to identity ids, frames sorted
    // and joined with `=`, body limited to format + content.
    expect(canonical).toBe(
      JSON.stringify({
        envelope: {
          from: "ed25519_pub_1",
          to: ["ed25519_pub_2"],
          cc: [],
          thread: "th_9f2c1",
          kind: "letter",
          lang: "en-AU",
          subject: "re: the plural-time archive",
        },
        time: { gregorian: "2026-08-29T14:00:00+04:00", frames: "season=autumn" },
        body: { format: "sealed", content: "age1ciphertext-armored" },
      }),
    );
  });

  it("falls back to the handle for legacy addresses without keys", () => {
    const letter = {
      envelope: {
        from: "legacy@house",
        to: ["other@house"],
        cc: [],
        thread: "th_x",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
      body: { format: "markdown", content: "hello" },
    };
    // The identity IS the handle until a key exists.
    expect(canonicalise(letter, new Map())).toContain('"from":"legacy@house"');
  });

  it("letterIdFromCanonical is a deterministic sha256 hex over the canonical form", async () => {
    const a = await letterIdFromCanonical("the same canonical");
    const b = await letterIdFromCanonical("the same canonical");
    const c = await letterIdFromCanonical("a different canonical");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(c).not.toBe(a);
  });
});

describe("seal/unseal round-trip", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("seals to a recipient and unseals with the matching identity", async () => {
    const a = await generateKeys();
    const b = await generateKeys();
    const cipher = await sealToRecipients("the storm is coming", [
      a.ageRecipient,
      b.ageRecipient,
    ]);
    const plain = await unsealWithIdentity(cipher, a.ageIdentity);
    expect(plain).toBe("the storm is coming");
    // A non-recipient cannot open it.
    const c = await generateKeys();
    expect(await unsealWithIdentity(cipher, c.ageIdentity)).toBeNull();
  });
});

describe("sealDraft — the resident's half of the flow", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("mints + registers keys, seals to participants, and signs the stored-form id", async () => {
    // First use: the writer's keypair lives in the keystore; the
    // address book does NOT yet carry it (nothing registered). sealDraft
    // detects the drift, registers the public halves, then signs with
    // the fresh key.
    const writer = await ensureKeys("chris@house");
    const recipient = await generateKeys();
    const addressBook = [
      { id: "sam@house", ageRecipient: recipient.ageRecipient, ed25519Public: recipient.ed25519Public, recoveryAgeRecipient: null },
    ];
    const registered: unknown[] = [];
    const result = await sealDraft(
      {
        envelope: {
          from: "chris@house",
          to: ["sam@house"],
          cc: [],
          thread: "th_sealed_1",
          kind: "letter",
          lang: "en-AU",
          subject: "a secret plan",
        },
        time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
        body: { format: "markdown", content: "step one\nthen step two" },
      },
      addressBook,
      {
        registerKeys: async (id, keys) => {
          registered.push({ id, keys });
          return { ok: true };
        },
      },
    );

    // Keys are registered once, on first use.
    expect(registered).toHaveLength(1);
    expect(result.minted).toBe(true);

    // The delivered letter's envelope subject is empty (the subject
    // moved into the body — SPEC §15), and the body is the sealed form.
    expect(result.letter.envelope.subject).toBe("");
    expect(result.letter.body.format).toBe("sealed");

    // The recipient can open it and reads the subject-line + body.
    const opened = await unsealWithIdentity(result.letter.body.content, recipient.ageIdentity);
    expect(opened).toBe("a secret plan\n\nstep one\nthen step two");

    // The signature is the sign of the stored-form id — the same id the
    // server re-derives from the delivered letter. We can verify with
    // the writer's public key (WebCrypto verify).
    const key = await crypto.subtle.importKey(
      "spki",
      new Uint8Array([...fromBase64url(writer.ed25519Public)]),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sig = await crypto.subtle.verify(
      "Ed25519",
      key,
      new Uint8Array([...fromBase64url(result.letter.body.signature)]),
      new TextEncoder().encode(result.id),
    );
    expect(sig).toBe(true);
  });

  it("refuses to seal to a participant without keys", async () => {
    const writer = await generateKeys();
    const addressBook = [{ id: "chris@house", ageRecipient: writer.ageRecipient, ed25519Public: writer.ed25519Public, recoveryAgeRecipient: null }];
    await expect(
      sealDraft(
        {
          envelope: {
            from: "chris@house",
            to: ["ghost@house"],
            cc: [],
            thread: "th_sealed_2",
            kind: "letter",
            lang: "en-AU",
            subject: "",
          },
          time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
          body: { format: "markdown", content: "hello" },
        },
        addressBook,
        { registerKeys: async () => ({ ok: true }) },
      ),
    ).rejects.toThrow(/no keys registered/);
  });
});

describe("recovery identity — the §15 backstop", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("mints a recovery identity idempotently — the same one comes back", async () => {
    const first = await mintRecoveryIdentity("you@house");
    expect(first.keys.recoveryAgeIdentity).toBeTruthy();
    expect(first.keys.recoveryAgeRecipient).toBeTruthy();
    const second = await mintRecoveryIdentity("you@house");
    // Idempotent — the same recovery identity, never a second.
    expect(second.recoveryIdentity).toBe(first.recoveryIdentity);
  });

  it("seals to the recovery recipient — a lost primary still opens (the fallback)", async () => {
    // Mint the writer's recovery identity (shows once, held client-side).
    const recovered = await mintRecoveryIdentity("chris@house");
    const recipient = await generateKeys();
    const addressBook = [
      { id: "sam@house", ageRecipient: recipient.ageRecipient, ed25519Public: recipient.ed25519Public, recoveryAgeRecipient: null },
    ];
    const result = await sealDraft(
      {
        envelope: {
          from: "chris@house",
          to: ["sam@house"],
          cc: [],
          thread: "th_recover_1",
          kind: "letter",
          lang: "en-AU",
          subject: "lost key drill",
        },
        time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
        body: { format: "markdown", content: "recover me" },
      },
      addressBook,
      { registerKeys: async () => ({ ok: true }) },
    );

    // The recipient set includes the recovery recipient (the backstop).
    expect(result.letter.body.recipients).toContain(recovered.keys.recoveryAgeRecipient);

    // Primary key is lost: unsealLetterBody must fall back to the
    // recovery identity and still open the letter.
    const opened = await unsealLetterBody("chris@house", result.letter.body.content);
    expect(opened).toBe("lost key drill\n\nrecover me");
  });
});

/** The sealed subject — SPEC §15: the subject is the one envelope field
 *  that is pure content, so it moves into the body. The composer states
 *  the contract at the field; these tests lock the wire form beneath it. */
describe("the sealed subject — the title moves into the body", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("empties the envelope subject and carries the title as the plaintext's first line", async () => {
    const recipient = await generateKeys();
    const addressBook = [
      { id: "sam@house", ageRecipient: recipient.ageRecipient, ed25519Public: recipient.ed25519Public, recoveryAgeRecipient: null },
    ];
    const result = await sealDraft(
      {
        envelope: {
          from: "chris@house",
          to: ["sam@house"],
          cc: [],
          thread: "th_subject_1",
          kind: "letter",
          lang: "en-AU",
          subject: "  the winter of the show  ",
        },
        time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
        body: { format: "markdown", content: "first line of the letter" },
      },
      addressBook,
      { registerKeys: async () => ({ ok: true }) },
    );

    // The stored form hashes an empty envelope subject — the house shows
    // "sealed letter", and the server re-derives the same id.
    expect(result.letter.envelope.subject).toBe("");

    const opened = await unsealWithIdentity(result.letter.body.content, recipient.ageIdentity);
    expect(opened).not.toBeNull();
    // The reader lifts the trimmed first line back out as the subject.
    const nl = opened!.indexOf("\n");
    expect(opened!.slice(0, nl)).toBe("the winter of the show");
    expect(opened!.slice(nl).replace(/^\n+/, "")).toBe("first line of the letter");
  });

  it("seals body-only when the subject is blank — no stray title line", async () => {
    const recipient = await generateKeys();
    const addressBook = [
      { id: "sam@house", ageRecipient: recipient.ageRecipient, ed25519Public: recipient.ed25519Public, recoveryAgeRecipient: null },
    ];
    const result = await sealDraft(
      {
        envelope: {
          from: "chris@house",
          to: ["sam@house"],
          cc: [],
          thread: "th_subject_2",
          kind: "letter",
          lang: "en-AU",
          subject: "   ",
        },
        time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [] },
        body: { format: "markdown", content: "the letter's own first line" },
      },
      addressBook,
      { registerKeys: async () => ({ ok: true }) },
    );
    const opened = await unsealWithIdentity(result.letter.body.content, recipient.ageIdentity);
    expect(opened).toBe("the letter's own first line");
  });
});

// tiny base64url helper for the test (kept local to avoid exposing a
// private function import path in the test surface).
function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
