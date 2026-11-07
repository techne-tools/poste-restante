/**
 * Answering a keyletter's offered key change — the route, hermetically.
 *
 * These are the four ways a resident can knock on this door, and the house
 * answers each with what it actually knows:
 *
 *   no offer                 404, the same absence as everything else
 *   a superseded offer       409 `stale_offer` — the keys they read are not
 *                            the keys that would be installed
 *   no letter named          400 `invalid_offer_answer`
 *   not a party to the letter 404, indistinguishable from "no offer". The
 *                            privacy rule is proven here as a NEGATIVE: the
 *                            non-party gets the same answer a stranger gets,
 *                            and no write happens.
 *
 * Plus the two answers themselves: accept installs the offered keys with
 * `origin = 'keyletter'` and settles the offer; decline settles it and leaves
 * the record alone.
 *
 * No postgres: the repository is a recording stub, so the test is about the
 * door's behaviour, not the schema (the integration suite covers that).
 */
import { describe, it, expect } from "vitest";
import { createAddressesRoutes } from "../../src/routes/addresses.js";
import type { AddressKeyOfferRecord } from "../../src/db/repository.js";

const OFFER: AddressKeyOfferRecord = {
  address: "corr@house",
  letter_id: "letter-1",
  age_recipient: "age1offered",
  ed25519_public: "ed-offered",
  recovery_age_recipient: null,
  created_at: new Date("2026-11-08T12:00:00.000Z"),
};

function harness(opts: {
  offer?: AddressKeyOfferRecord | null;
  /** Is the caller on the keyletter's envelope? */
  party?: boolean;
  who?: string | null;
}) {
  const writes: { method: string; args: unknown[] }[] = [];
  const repo = {
    getKeyOffer: async () => opts.offer ?? null,
    getLetter: async () =>
      opts.party === false
        ? null
        : { thread_id: "th_key", from_addr: "corr@house", to_addrs: ["you@house"], cc_addrs: [] },
    participationStates: async () => new Map([["th_key", "in"]]),
    setAddressKey: async (...args: unknown[]) => {
      writes.push({ method: "setAddressKey", args });
    },
    resolveKeyOffer: async (...args: unknown[]) => {
      writes.push({ method: "resolveKeyOffer", args });
    },
    getAddressKey: async () => ({
      age_recipient: "age1offered",
      ed25519_public: "ed-offered",
      recovery_age_recipient: null,
    }),
  };
  const house = {
    repo,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const caller =
    opts.who === null
      ? async () => null
      : async () => ({ address: opts.who ?? "you@house", method: "basic" });
  const app = createAddressesRoutes(house as never, caller as never, undefined, undefined, undefined, {} as never);
  return { app, writes };
}

const post = (app: ReturnType<typeof harness>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("answering a key change", () => {
  it("answers 400 when the resident did not say which keyletter", async () => {
    const { app } = harness({ offer: OFFER });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_offer_answer");
  });

  it("answers 404 when there is nothing pending", async () => {
    const { app } = harness({ offer: null });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "letter-1",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("refuses to install keys the resident did not just read — the offer moved", async () => {
    const { app, writes } = harness({ offer: OFFER });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "an-older-letter",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("stale_offer");
    expect(writes).toEqual([]);
  });

  it("installs the offered keys on accept, still with keyletter origin", async () => {
    const { app, writes } = harness({ offer: OFFER, who: "you@house" });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "letter-1",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, letterId: "letter-1" });
    expect(writes).toEqual([
      {
        method: "setAddressKey",
        args: [
          "corr@house",
          {
            ageRecipient: "age1offered",
            ed25519Public: "ed-offered",
            recoveryAgeRecipient: null,
          },
          "keyletter",
          "letter-1",
        ],
      },
      { method: "resolveKeyOffer", args: ["corr@house", "accepted"] },
    ]);
  });

  it("leaves the record alone on decline", async () => {
    const { app, writes } = harness({ offer: OFFER, who: "you@house" });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/decline", {
      letterId: "letter-1",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(false);
    expect(writes).toEqual([{ method: "resolveKeyOffer", args: ["corr@house", "declined"] }]);
  });

  it("tells a non-party nothing, and writes nothing — the negative", async () => {
    const { app, writes } = harness({ offer: OFFER, party: false, who: "stranger@house" });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "letter-1",
    });
    // The same answer an offer that does not exist gets: absence is silence.
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
    expect(writes).toEqual([]);
  });

  it("does not let a non-party probe for an offer with a wrong letter id", async () => {
    // The `stale_offer` branch must not become an oracle: answering 409 to a
    // mismatched id would tell a stranger that an offer exists at this address.
    const { app, writes } = harness({ offer: OFFER, party: false, who: "stranger@house" });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "some-other-letter",
    });
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });

  it("needs a caller at all", async () => {
    const { app } = harness({ offer: OFFER, who: null });
    const res = await post(app, "/v1/addresses/corr@house/keys/offer/accept", {
      letterId: "letter-1",
    });
    expect(res.status).toBe(401);
  });
});
