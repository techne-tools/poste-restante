/**
 * The keyletter, client side — SPEC §15.
 *
 * The one thing that must not drift: the canonical form. The client hashes the
 * frame INCLUDING its keys, in a fixed field order, without the signature —
 * byte for byte what `server/src/id.ts::canonicalBody` emits. A drift does not
 * fail quietly; it fails as a letter the house refuses at the signature gate.
 * So the form is frozen here as a literal, the way the sealed body's is.
 *
 * The second thing: the signature is over the id the frame hashes to, made
 * with the private half of the key inside the frame. That is verified here
 * against the published key with Web Crypto — the same check the house makes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  canonicalise,
  ensureKeys,
  letterIdFromCanonical,
  createKeystore,
  lockAllKeystores,
  generateKeys,
  KeystoreLockedError,
  KeystoreAbsentError,
} from "./crypto";
import { KEY_LETTER_NOTE, canReceiveKeys, composeKeyLetter } from "./keyletter";
import type { Address } from "../api";

const PASSPHRASE = "the light in the rehearsal room";
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

/** Verify a base64url ed25519 signature over a letter id, with the published
 *  spki key — the house's check, done with Web Crypto. */
async function verifies(id: string, signature: string, ed25519Public: string): Promise<boolean> {
  const der = Uint8Array.from(atob(ed25519Public.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  return crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(id));
}

describe("the key frame's canonical form — the exact mirror of the server's", () => {
  it("hashes the keys, in a fixed order, without the signature", () => {
    const canonical = canonicalise(
      {
        envelope: {
          from: "chris@house",
          to: ["sam@house"],
          cc: [],
          thread: "th_key_1",
          kind: "keyletter",
          lang: "en-AU",
          subject: "my keys",
        },
        time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
        body: {
          format: "keyframe",
          content: "These are my keys — seal to me.",
          keys: {
            ageRecipient: "age1recipient",
            ed25519Public: "ed25519_public",
            recoveryAgeRecipient: "age1recovery",
          },
        },
      },
      new Map([
        ["chris@house", "ed_pin_1"],
        ["sam@house", "ed_pin_2"],
      ]),
    );

    // Field order fixed, addresses resolved to their durable identities, and
    // the keys inside the body — this is what the house re-derives, and an id
    // that does not match is a letter it refuses.
    expect(canonical).toBe(
      JSON.stringify({
        envelope: {
          from: "ed_pin_1",
          to: ["ed_pin_2"],
          cc: [],
          thread: "th_key_1",
          kind: "keyletter",
          lang: "en-AU",
          subject: "my keys",
        },
        time: { gregorian: "2026-11-08T12:00:00.000Z", frames: "" },
        body: {
          format: "keyframe",
          content: "These are my keys — seal to me.",
          keys: {
            ageRecipient: "age1recipient",
            ed25519Public: "ed25519_public",
            recoveryAgeRecipient: "age1recovery",
          },
        },
      }),
    );
  });

  it("keeps the two original shapes unchanged — no key field leaks into them", () => {
    const letter = {
      envelope: {
        from: "a@house",
        to: ["b@house"],
        cc: [],
        thread: "th",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
      body: { format: "markdown", content: "hello" },
    };
    expect(canonicalise(letter, new Map())).toContain('"body":{"format":"markdown","content":"hello"}');
  });

  it("refuses to hash a key frame that carries no keys", () => {
    expect(() =>
      canonicalise(
        {
          envelope: {
            from: "a@house",
            to: ["b@house"],
            cc: [],
            thread: "th",
            kind: "keyletter",
            lang: "en-AU",
            subject: "",
          },
          time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
          body: { format: "keyframe", content: "no keys here" },
        },
        new Map(),
      ),
    ).toThrow(/must carry its keys/);
  });
});

describe("composeKeyLetter", () => {
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
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: saved,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("signs the id its own frame hashes to, with the key it publishes", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const keys = ensureKeys("chris@house");

    const { letter, id } = await composeKeyLetter({
      from: "chris@house",
      to: "sam@house",
      addressBook: [],
      thread: "th_key_1",
      gregorian: "2026-11-08T12:00:00.000Z",
    });

    // The letter is a keyletter carrying the resident's real halves.
    expect(letter.envelope.kind).toBe("keyletter");
    expect(letter.body.format).toBe("keyframe");
    expect(letter.body.keys).toEqual({
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      recoveryAgeRecipient: keys.recoveryAgeRecipient,
    });
    expect(letter.body.content).toBe(KEY_LETTER_NOTE);

    // The id is the hash of the canonical form the house will re-derive: an
    // unregistered sender resolves to its HANDLE (a keyletter installs keys
    // but never pins an identity, so nothing moves), and a keyless recipient
    // resolves to its handle too.
    const expected = await letterIdFromCanonical(
      canonicalise(
        {
          envelope: letter.envelope,
          time: letter.time,
          body: {
            format: "keyframe",
            content: letter.body.content,
            keys: letter.body.keys,
          },
        },
        new Map([
          ["chris@house", "chris@house"],
          ["sam@house", "sam@house"],
        ]),
      ),
    );
    expect(id).toBe(expected);

    // And the signature verifies under the key the frame publishes — which is
    // the whole authenticity story of a keyletter.
    expect(await verifies(id, letter.body.signature, letter.body.keys.ed25519Public)).toBe(true);
  });

  it("uses the address book's durable identity for a registered sender", async () => {
    await createKeystore("chris@house", PASSPHRASE);
    const keys = ensureKeys("chris@house");
    const recipient = await generateKeys();

    const { id } = await composeKeyLetter({
      from: "chris@house",
      to: "sam@house",
      addressBook: [
        {
          id: "chris@house",
          // A pin that is NOT the live key: the id must follow the pin, or a
          // rotation would move every keyletter's id.
          identityId: "the_pinned_fingerprint",
          ageRecipient: keys.ageRecipient,
          ed25519Public: keys.ed25519Public,
          recoveryAgeRecipient: null,
        },
        {
          id: "sam@house",
          identityId: recipient.ed25519Public,
          ageRecipient: recipient.ageRecipient,
          ed25519Public: recipient.ed25519Public,
          recoveryAgeRecipient: null,
        },
      ],
      thread: "th_key_2",
      gregorian: "2026-11-08T12:00:00.000Z",
    });

    const expected = await letterIdFromCanonical(
      canonicalise(
        {
          envelope: {
            from: "chris@house",
            to: ["sam@house"],
            cc: [],
            thread: "th_key_2",
            kind: "keyletter",
            lang: "en-AU",
            subject: "my keys",
          },
          time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
          body: {
            format: "keyframe",
            content: KEY_LETTER_NOTE,
            keys: {
              ageRecipient: keys.ageRecipient,
              ed25519Public: keys.ed25519Public,
              recoveryAgeRecipient: keys.recoveryAgeRecipient,
            },
          },
        },
        new Map([
          ["chris@house", "the_pinned_fingerprint"],
          ["sam@house", recipient.ed25519Public],
        ]),
      ),
    );
    expect(id).toBe(expected);
  });

  it("needs the keystore open — a signing act without a passphrase is not one", async () => {
    await expect(
      composeKeyLetter({ from: "nobody@house", to: "sam@house", addressBook: [] }),
    ).rejects.toBeInstanceOf(KeystoreAbsentError);

    await createKeystore("locked@house", PASSPHRASE);
    lockAllKeystores();
    await expect(
      composeKeyLetter({ from: "locked@house", to: "sam@house", addressBook: [] }),
    ).rejects.toBeInstanceOf(KeystoreLockedError);
  });
});

describe("who a keyletter can be sent to", () => {
  const address = (over: Partial<Address> = {}): Address =>
    ({
      id: "sam@house",
      names: [],
      pronouns: null,
      ageRecipient: null,
      ed25519Public: null,
      recoveryAgeRecipient: null,
      isAgent: false,
      sealDefault: false,
      ...over,
    }) as Address;

  it("a keyless correspondent — the case the letter exists for", () => {
    expect(canReceiveKeys(address(), "chris@house")).toBe(true);
  });

  it("not yourself, and not an instrument", () => {
    expect(canReceiveKeys(address({ id: "chris@house" }), "chris@house")).toBe(false);
    expect(canReceiveKeys(address({ isAgent: true }), "chris@house")).toBe(false);
    expect(canReceiveKeys(undefined, "chris@house")).toBe(false);
  });
});
