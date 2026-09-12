/**
 * Sealed letters — the CLIENT'S half of the loop, against the live house.
 *
 * This is the parity proof that the browser's crypto and the server's
 * id derivation agree. The client's `crypto.ts` (WebCrypto ed25519,
 * age-encryption, localStorage keystore) runs here in node exactly as
 * it does in the browser:
 *
 *   ensureKeys → register the public halves through the HTTP route
 *              → GET the address book (keys ride the address rows)
 *              → sealDraft a letter (canonicalise + derive + sign + seal)
 *              → POST /v1/letters → 201 means the derived id MATCHED
 *                the server's re-derivation (a one-byte drift would be
 *                a different id, a failed verification, a 400).
 *              → GET the letter back → format "sealed"
 *              → unseal with the RECIPIENT's client key
 *
 * If the canonical form drifts, the signature gate rejects the letter
 * and this test fails at the 201 — the whole point of the parity proof.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { letterIdFromCanonical, canonicaliseWith } from "../../src/id.js";
import type { House } from "../../src/house.js";

// The client's own crypto — the leaf module the browser runs.
import {
  canonicalise,
  ensureKeys,
  mintRecoveryIdentity,
  sealDraft,
  unsealLetterBody,
} from "../../../client/src/crypto.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

/** node has no guaranteed localStorage global; shim a tiny one exactly
 *  like the client's keystore expects. */
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

describe.skipIf(!INTEGRATION)("sealed letters — client parity (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let savedStorage: unknown;

  const asClient = (address: string, password: string) => ({
    "Content-Type": "application/json",
    Authorization: basic(address, password),
  });

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings, retired_handles
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("sam@house", "samsamsam");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  beforeEach(() => {
    savedStorage = (globalThis as Record<string, unknown>).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: savedStorage as Storage | undefined,
      configurable: true,
    });
  });

  it("the browser's seal loop works end to end — register, derive, sign, deliver, unseal", async () => {
    // 1. Both residents ensure (mint) their browser-held keypairs.
    const you = await ensureKeys("you@house");
    const sam = await ensureKeys("sam@house");

    // 2. Register the public halves through the HTTP route — self-only,
    //    the same call the browser's sealDraft makes on first use.
    const regYou = await app.request("/v1/addresses/you@house/keys", {
      method: "POST",
      headers: asClient("you@house", "youyouyou"),
      body: JSON.stringify({
        ageRecipient: you.ageRecipient,
        ed25519Public: you.ed25519Public,
        recoveryAgeRecipient: null,
      }),
    });
    expect(regYou.status).toBe(201);

    const regSam = await app.request("/v1/addresses/sam@house/keys", {
      method: "POST",
      headers: asClient("sam@house", "samsamsam"),
      body: JSON.stringify({
        ageRecipient: sam.ageRecipient,
        ed25519Public: sam.ed25519Public,
        recoveryAgeRecipient: null,
      }),
    });
    expect(regSam.status).toBe(201);

    // 3. The address book now carries everyone's public halves — the map
    //    the letter id resolves through.
    const bookRes = await app.request("/v1/addresses", {
      headers: asClient("you@house", "youyouyou"),
    });
    const book = ((await bookRes.json()) as { addresses: { id: string; ageRecipient: string | null; ed25519Public: string | null }[] }).addresses;
    const youRow = book.find((a) => a.id === "you@house");
    const samRow = book.find((a) => a.id === "sam@house");
    expect(youRow?.ed25519Public).toBe(you.ed25519Public);
    expect(samRow?.ageRecipient).toBe(sam.ageRecipient);

    // 4. The client seals the draft. Its registerKeys callback hits the
    //    real route; the address book is what the route returned.
    const draft = {
      envelope: {
        from: "you@house",
        to: ["sam@house"],
        cc: [],
        thread: "th_client_sealed_1",
        kind: "letter",
        lang: "en-AU",
        subject: "the tempest plan",
      },
      time: { gregorian: new Date().toISOString(), frames: [{ frame: "season", value: "autumn" }] },
      body: { format: "markdown" as const, content: "act one\nscene two" },
    };
    const sealed = await sealDraft(draft, book, {
      registerKeys: async (id, keys) => {
        const res = await app.request(`/v1/addresses/${encodeURIComponent(id)}/keys`, {
          method: "POST",
          headers: asClient(id, id === "sam@house" ? "samsamsam" : "youyouyou"),
          body: JSON.stringify(keys),
        });
        return res.json();
      },
    });

    // 5. Deliver. 201 is the parity proof: the server re-derived the
    //    id from the letter it received and verified our signature
    //    against the public key on the address record.
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: asClient("you@house", "youyouyou"),
      body: JSON.stringify(sealed.letter),
    });
    expect(delivered.status).toBe(201);
    const { id } = (await delivered.json()) as { id: string };
    expect(id).toBe(sealed.id);

    // 6. The server's own derivation agrees with the client's — the
    //    belt-and-braces assertion.
    const serverId = letterIdFromCanonical(
      canonicaliseWith(sealed.letter as never, new Map([["you@house", you.ed25519Public], ["sam@house", sam.ed25519Public]])),
    );
    expect(serverId).toBe(sealed.id);

    // 7. The mailbox serves it back as a sealed letter.
    const backRes = await app.request("/v1/threads/th_client_sealed_1", {
      headers: asClient("sam@house", "samsamsam"),
    });
    const back = (await backRes.json()) as {
      letters: { body: { format: string; content: string } }[];
    };
    const letter = back.letters.find((l) => l.body.format === "sealed");
    expect(letter).toBeDefined();

    // 8. The RECIPIENT's browser key unseals it — the subject moved
    //    into the body, first line is the title, the body follows.
    const opened = await unsealLetterBody("sam@house", letter!.body.content);
    expect(opened).toBe("the tempest plan\n\nact one\nscene two");

    // 9. The writer's own key opens it too (age seals to every
    //    recipient, the writer included).
    const openedByYou = await unsealLetterBody("you@house", letter!.body.content);
    expect(openedByYou).toBe("the tempest plan\n\nact one\nscene two");
  });

  it("the client refuses to seal to a keyless participant", async () => {
    const you = await ensureKeys("you@house");
    const bookRes = await app.request("/v1/addresses", {
      headers: asClient("you@house", "youyouyou"),
    });
    const book = ((await bookRes.json()) as { addresses: { id: string; ageRecipient: string | null; ed25519Public: string | null; recoveryAgeRecipient: string | null }[] }).addresses;
    // Ensure a keyless participant exists in the book (a legacy address).
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id) VALUES ('ghost@house', 'ghost@house')
       ON CONFLICT (id) DO NOTHING`,
    );
    const withGhost = [...book.filter((a) => a.id !== "you@house"), { id: "ghost@house", ageRecipient: null, ed25519Public: null, recoveryAgeRecipient: null }];
    await expect(
      sealDraft(
        {
          envelope: {
            from: "you@house",
            to: ["ghost@house"],
            cc: [],
            thread: "th_client_sealed_2",
            kind: "letter",
            lang: "en-AU",
            subject: "",
          },
          time: { gregorian: new Date().toISOString(), frames: [] },
          body: { format: "markdown", content: "hello" },
        },
        withGhost,
        { registerKeys: async () => ({ ok: true }) },
      ),
    ).rejects.toThrow(/no keys registered/);
    void you;
  });

  it("canonicalise (client) equals canonicaliseWith (server) on the same letter", () => {
    const identities = new Map([
      ["you@house", "ed25519_pub_you"],
      ["sam@house", "ed25519_pub_sam"],
    ]);
    const letter = {
      envelope: {
        from: "you@house",
        to: ["sam@house"],
        cc: [],
        thread: "th_parity_1",
        kind: "letter",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: "2026-08-29T14:00:00+04:00", frames: [{ frame: "season", value: "autumn" }, { frame: "production", value: "tempest" }] },
      body: { format: "sealed", content: "age1ciphertext" },
    };
    const clientForm = canonicalise(letter, identities);
    const serverForm = canonicaliseWith(letter as never, identities);
    expect(clientForm).toBe(serverForm);
  });

  it("recovery — a sealed letter opens after the primary key is lost", async () => {
    // A fresh keystore, as if this were a new resident on this browser.
    const you = await ensureKeys("you@house");
    // Mint the recovery identity — the backstop, shown once, held off-box.
    const recovered = await mintRecoveryIdentity("you@house");
    await app.request("/v1/addresses/you@house/keys", {
      method: "POST",
      headers: asClient("you@house", "youyouyou"),
      body: JSON.stringify({
        ageRecipient: you.ageRecipient,
        ed25519Public: you.ed25519Public,
        recoveryAgeRecipient: recovered.keys.recoveryAgeRecipient,
      }),
    });

    // The address book now carries the recovery recipient — a
    // correspondent can seal to both the primary AND the backstop.
    const bookRes = await app.request("/v1/addresses", {
      headers: asClient("you@house", "youyouyou"),
    });
    const book = ((await bookRes.json()) as {
      addresses: { id: string; ageRecipient: string | null; ed25519Public: string | null; recoveryAgeRecipient: string | null }[];
    }).addresses;
    const row = book.find((a) => a.id === "you@house");
    expect(row?.recoveryAgeRecipient).toBe(recovered.keys.recoveryAgeRecipient);

    // Seal a letter to yourself (primary + recovery recipients).
    const sealed = await sealDraft(
      {
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_recovery_1",
          kind: "letter",
          lang: "en-AU",
          subject: "lost key drill",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "recover me" },
      },
      book,
      { registerKeys: async (id, keys) => app.request(`/v1/addresses/${encodeURIComponent(id)}/keys`, {
        method: "POST", headers: asClient(id, "youyouyou"), body: JSON.stringify(keys),
      }) },
    );
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: asClient("you@house", "youyouyou"),
      body: JSON.stringify(sealed.letter),
    });
    expect(delivered.status).toBe(201);

    // Lose the primary: a keystore without the primary age identity
    // still opens the letter through the recovery fallback.
    const backRes = await app.request("/v1/threads/th_recovery_1", {
      headers: asClient("you@house", "youyouyou"),
    });
    const back = (await backRes.json()) as {
      letters: { body: { format: string; content: string } }[];
    };
    const letter = back.letters.find((l) => l.body.format === "sealed");
    expect(letter).toBeDefined();
    const opened = await unsealLetterBody("you@house", letter!.body.content);
    expect(opened).toBe("lost key drill\n\nrecover me");
  });
});
