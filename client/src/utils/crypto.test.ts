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
  sealPayload,
  unsealPayload,
  createKeystore,
  lockAllKeystores,
  KeystoreLockedError,
  KeystoreAbsentError,
  keyProofMessage,
  registerKeysWithProof,
} from "./crypto";
import type { KeyRegistrationProof } from "./crypto";
import { armor } from "age-encryption";

/** A passphrase long enough for the keystore's floor. */
const PASSPHRASE = "the light in the rehearsal room";

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
    // The keystore's session vault is module state and outlives a test.
    lockAllKeystores();
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
    expect(plain).toEqual({ ok: true, plaintext: "the storm is coming" });
    // A non-recipient cannot open it — and is told that, not "tampered".
    const c = await generateKeys();
    expect(await unsealWithIdentity(cipher, c.ageIdentity)).toEqual({
      ok: false,
      reason: "not_recipient",
    });
  });
});

describe("sealDraft — the resident's half of the flow", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    // The keystore's session vault is module state and outlives a test.
    lockAllKeystores();
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
    // First use: the writer's keypair lives in the sealed keystore; the
    // address book does NOT yet carry it (nothing registered). sealDraft
    // detects the drift, registers the public halves, then signs with
    // the open key.
    await createKeystore("chris@house", PASSPHRASE);
    const writer = ensureKeys("chris@house");
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
        requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
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
    expect(opened).toEqual({ ok: true, plaintext: "a secret plan\n\nstep one\nthen step two" });

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
    await createKeystore("chris@house", PASSPHRASE);
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
        {
          requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
          registerKeys: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow(/no keys registered/);
  });
});

describe("recovery identity — the §15 backstop", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    // The keystore's session vault is module state and outlives a test.
    lockAllKeystores();
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
    await createKeystore("you@house", PASSPHRASE);
    const first = await mintRecoveryIdentity("you@house");
    expect(first.keys.recoveryAgeIdentity).toBeTruthy();
    expect(first.keys.recoveryAgeRecipient).toBeTruthy();
    const second = await mintRecoveryIdentity("you@house");
    // Idempotent — the same recovery identity, never a second.
    expect(second.recoveryIdentity).toBe(first.recoveryIdentity);
  });

  it("seals to the recovery recipient — a lost primary still opens (the fallback)", async () => {
    // Mint the writer's recovery identity (shows once, held client-side).
    await createKeystore("chris@house", PASSPHRASE);
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
      {
        requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
        registerKeys: async () => ({ ok: true }),
      },
    );

    // The recipient set includes the recovery recipient (the backstop).
    expect(result.letter.body.recipients).toContain(recovered.keys.recoveryAgeRecipient);

    // Primary key is lost: unsealLetterBody must fall back to the
    // recovery identity and still open the letter.
    const opened = await unsealLetterBody("chris@house", result.letter.body.content);
    expect(opened).toEqual({ ok: true, plaintext: "lost key drill\n\nrecover me" });
  });
});

/** The sealed subject — SPEC §15: the subject is the one envelope field
 *  that is pure content, so it moves into the body. The composer states
 *  the contract at the field; these tests lock the wire form beneath it. */
describe("the sealed subject — the title moves into the body", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    // The keystore's session vault is module state and outlives a test.
    lockAllKeystores();
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
    await createKeystore("chris@house", PASSPHRASE);
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
      {
        requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
        registerKeys: async () => ({ ok: true }),
      },
    );

    // The stored form hashes an empty envelope subject — the house shows
    // "sealed letter", and the server re-derives the same id.
    expect(result.letter.envelope.subject).toBe("");

    const opened = await unsealWithIdentity(result.letter.body.content, recipient.ageIdentity);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The reader lifts the trimmed first line back out as the subject.
    const nl = opened.plaintext.indexOf("\n");
    expect(opened.plaintext.slice(0, nl)).toBe("the winter of the show");
    expect(opened.plaintext.slice(nl).replace(/^\n+/, "")).toBe("first line of the letter");
  });

  it("seals body-only when the subject is blank — no stray title line", async () => {
    await createKeystore("chris@house", PASSPHRASE);
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
      {
        requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
        registerKeys: async () => ({ ok: true }),
      },
    );
    const opened = await unsealWithIdentity(result.letter.body.content, recipient.ageIdentity);
    expect(opened).toEqual({ ok: true, plaintext: "the letter's own first line" });
  });
});

describe("a sealed keystore refuses to seal", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    lockAllKeystores();
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    lockAllKeystores();
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("tells the resident to open their keys, and does not invent a second keypair", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    lockAllKeystores();

    const before = globalThis.localStorage.getItem("poste-restante.keystore");
    await expect(
      sealDraft(
        {
          envelope: {
            from: "chris@house",
            to: ["sam@house"],
            cc: [],
            thread: "th_locked_1",
            kind: "letter",
            lang: "en-AU",
            subject: "a secret",
          },
          time: { gregorian: "2026-11-08T09:00:00+04:00", frames: [] },
          body: { format: "markdown", content: "hello" },
        },
        [],
        {
          requestKeyChallenge: async () => ({ nonce: "1700000000.a-test-nonce" }),
          registerKeys: async () => ({ ok: true }),
        },
      ),
    ).rejects.toBeInstanceOf(KeystoreLockedError);

    // Refused before any write — the record is untouched, and no fresh
    // keypair has quietly replaced the sealed one.
    expect(globalThis.localStorage.getItem("poste-restante.keystore")).toBe(before);
  });

  it("refuses to invent keys for a browser that holds none", () => {
    expect(() => ensureKeys("nobody@house")).toThrow(KeystoreAbsentError);
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

/* ── Sealed payloads — C1: the enclosure sealed like the body ───────────── */

describe("sealed payloads — the enclosure's own seal", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    lockAllKeystores();
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    lockAllKeystores();
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("seals a file to a recipient and opens it again with name, type and bytes intact", async () => {
    const keys = await createKeystore("chris@house", PASSPHRASE);
    const bytes = new TextEncoder().encode("REHEARSAL TAKE THREE — storm cue at 47");
    const file = new Blob([bytes], { type: "audio/wav" });

    const sealed = await sealPayload(file, [keys.ageRecipient], {
      name: "take-3.wav",
      contentType: "audio/wav",
    });

    // The ciphertext carries none of the plaintext and none of the name's
    // content: what the house stores is opaque.
    const raw = new Uint8Array(await sealed.arrayBuffer());
    const rawText = new TextDecoder().decode(raw);
    expect(rawText).not.toContain("REHEARSAL TAKE THREE");
    expect(rawText).not.toContain("storm cue");
    // Raw age, not armoured — an enclosure is binary.
    expect(rawText).not.toContain("BEGIN AGE ENCRYPTED FILE");

    const opened = await unsealPayload("chris@house", sealed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.name).toBe("take-3.wav");
    expect(opened.contentType).toBe("audio/wav");
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(bytes);
  });

  it("refuses to open an enclosure sealed to somebody else", async () => {
    const mine = await createKeystore("chris@house", PASSPHRASE);
    const theirs = await generateKeys();
    const sealed = await sealPayload(new Blob([new Uint8Array([1, 2, 3])]), [theirs.ageRecipient], {
      name: "theirs.bin",
      contentType: "application/octet-stream",
    });

    // chris's own key is in the keystore, but the enclosure was not sealed
    // to it. Honest failure, not a silent drop.
    expect(mine.ageRecipient).not.toBe(theirs.ageRecipient);
    const opened = await unsealPayload("chris@house", sealed);
    expect(opened).toEqual({ ok: false, reason: "failed" });
  });

  it("fails honestly when the ciphertext was tampered with, rather than hanging", async () => {
    const keys = await createKeystore("chris@house", PASSPHRASE);
    const sealed = await sealPayload(new Blob([new TextEncoder().encode("x".repeat(4096))]), [keys.ageRecipient], {
      name: "tampered.bin",
      contentType: "application/octet-stream",
    });
    const bytes = new Uint8Array(await sealed.arrayBuffer());
    // Flip a byte deep in the body: the MAC fails at the end of the stream.
    bytes[bytes.length - 10] ^= 0xff;
    const opened = await unsealPayload("chris@house", new Blob([bytes]));
    expect(opened).toEqual({ ok: false, reason: "failed" });
  });

  it("says 'no_keys' when this device holds no key for the address", async () => {
    const keys = await generateKeys();
    const sealed = await sealPayload(new Blob([new Uint8Array([1])]), [keys.ageRecipient], {
      name: "x.bin",
      contentType: "application/octet-stream",
    });
    const opened = await unsealPayload("nobody@house", sealed);
    expect(opened).toEqual({ ok: false, reason: "no_keys" });
  });

  it("will not seal to an empty recipient set — an unopenable enclosure is not an enclosure", async () => {
    await expect(
      sealPayload(new Blob([new Uint8Array([1])]), [], { name: "x.bin", contentType: "text/plain" }),
    ).rejects.toThrow(/at least one recipient/);
  });

  it("seals to the recovery recipient too, so a lost primary key still opens it", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const minted = await mintRecoveryIdentity("chris@house");
    const bytes = new TextEncoder().encode("recovered");
    // Sealed ONLY to the recovery recipient — the primary key is gone, and
    // the reader's keystore must fall back to the off-box recovery identity.
    const sealed = await sealPayload(new Blob([bytes]), [minted.keys.recoveryAgeRecipient!], {
      name: "recovered.bin",
      contentType: "application/octet-stream",
    });
    const opened = await unsealPayload("chris@house", sealed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(bytes);
  });
});

/* ── Proof of possession — the resident's half of a key registration ────── */

describe("proof of possession — registering keys proves the key", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    lockAllKeystores();
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    lockAllKeystores();
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("builds the exact message the server checks — the mirror is a literal", () => {
    // The same literal is asserted in
    // server/test/unit/key-proof.test.ts. If either side drifts, its own
    // test fails rather than every registration failing in the field.
    expect(
      keyProofMessage({
        address: "chris@house",
        nonce: "1700000000.abc",
        ageRecipient: "age1qqq",
        ed25519Public: "AAAA",
        recoveryAgeRecipient: null,
      }),
    ).toBe("poste-restante:key-proof:v1\nchris@house\n1700000000.abc\nage1qqq\nAAAA\n");
  });

  it("asks for a challenge, signs it with the resident's key, and posts the halves with the proof", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const keys = ensureKeys("chris@house");
    const halves = {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      recoveryAgeRecipient: null,
    };

    let asked: string | null = null;
    let posted: KeyRegistrationProof | null = null;
    await registerKeysWithProof("chris@house", halves, {
      requestKeyChallenge: async (id) => {
        asked = id;
        return { nonce: "1700000000.abc" };
      },
      registerKeys: async (_id, body) => {
        posted = body;
        return { ok: true };
      },
    });

    expect(asked).toBe("chris@house");
    expect(posted).not.toBeNull();
    expect(posted).toMatchObject({ ...halves, nonce: "1700000000.abc" });

    // The signature verifies with the public half being registered, over
    // the exact message the server will rebuild. Nothing else could.
    const verifyKey = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(fromBase64url(keys.ed25519Public)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      verifyKey,
      new Uint8Array(fromBase64url(posted!.signature)),
      new TextEncoder().encode(
        keyProofMessage({ address: "chris@house", nonce: "1700000000.abc", ...halves }),
      ),
    );
    expect(ok).toBe(true);
  });

  it("refuses to register while the keystore is sealed — proof needs the key open", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const keys = ensureKeys("chris@house");
    const halves = {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      recoveryAgeRecipient: null,
    };
    lockAllKeystores();

    let posted = false;
    await expect(
      registerKeysWithProof("chris@house", halves, {
        requestKeyChallenge: async () => ({ nonce: "1700000000.abc" }),
        registerKeys: async () => {
          posted = true;
          return { ok: true };
        },
      }),
    ).rejects.toBeInstanceOf(KeystoreLockedError);
    expect(posted).toBe(false);
  });
});

/* ── The reader's three silences — item 4, client half ──────────────────── */

describe("unsealLetterBody — a tampered letter is not 'not yours'", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    lockAllKeystores();
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    lockAllKeystores();
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", { value: saved, configurable: true });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("separates 'sealed to you and altered' from 'sealed to somebody else'", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const keys = ensureKeys("chris@house");
    const theirs = await generateKeys();

    const mine = await sealToRecipients("a letter for chris", [keys.ageRecipient]);
    const notMine = await sealToRecipients("a letter for sam", [theirs.ageRecipient]);

    // Theirs: open keys, no matching stanza — a fact about addressing.
    expect(await unsealLetterBody("chris@house", notMine)).toEqual({
      ok: false,
      reason: "not_recipient",
    });

    // Mine, altered: the seal does not hold. Reporting this as "not yours"
    // would send the reader hunting for a key they already have.
    const raw = new Uint8Array(armor.decode(mine));
    raw[raw.length - 1] ^= 0xff;
    expect(await unsealLetterBody("chris@house", armor.encode(raw))).toEqual({
      ok: false,
      reason: "failed",
    });

    // And the untouched one still opens.
    expect(await unsealLetterBody("chris@house", mine)).toEqual({
      ok: true,
      plaintext: "a letter for chris",
    });
  });
});
