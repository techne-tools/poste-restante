import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "../auth/rate-limiter.js";
import { LETTER_KINDS } from "../types.js";
import { AddressSchema, LetterSchema, RedeemSchema, ChangePasswordSchema, RegisterKeysSchema, ClauseActionSchema, DayCardSchema, InviteSchema, toLetter } from "../schemas.js";
import { deliverLetter } from "../deliver.js";
import type { House } from "../house.js";
import type { RetrievalQuery } from "../retrieval/retrieval.js";
import type { AuthService, Authenticated } from "../auth/service.js";
import { isVisibleTo, isPublicAddress, visibleToSql, filterVisible, PUB_ADDRESS } from "../auth/visibility.js";
import type { InviteService } from "../invites/service.js";
import type { BookService } from "../book/service.js";
import { BOOK_ADDRESS } from "../book/service.js";
import type { OidcPending } from "../server.js";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../server.js";

export function createAgentsRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // Renew an instrument — a develop of the birth thread. A creator (or a
  // named beneficiary, who is the future creator) extends the lifespan
  // frame: the agent cannot extend itself (SPEC §16, "scope creep is a
  // human letter"), and a stranger cannot either. The act IS a letter;
  // the archive keeps the will; the token is re-minted (the capability
  // to act as the address is held by whoever holds the newest token).
  app.post("/v1/agents/:address/renew", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("address");
    const body = (await c.req.json().catch(() => null)) as { lifespan?: string } | null;
    if (!body?.lifespan || !body.lifespan.trim()) {
      return c.json({ error: { code: "invalid_renew", message: "a develop needs a lifespan frame" } }, 400);
    }
    const result = await house.agents.develop(address, who.address, body.lifespan.trim());
    if (!result.success) {
      // The house refuses without saying which rule — only the creator
      // or the named beneficiary may renew, and a dead instrument cannot.
      return c.json({ error: { code: "forged", message: "only the creator or the named beneficiary may renew this instrument" } }, 403);
    }
    house.log.info("agent:renewed-over-http", { address, developer: who.address, lifespan: body.lifespan.trim() });
    // The token is shown once — the plaintext lives only in this response
    // (the stored value is the hash).
    return c.json({ renewed: true, address, lifespan: body.lifespan.trim(), token: result.token });
  });

  // Bequest on creator departure — the beneficiary opts in. Only the
  // named beneficiary (a resident) may adopt; the address, scope, and
  // history pass to them; the past stays sealed to the old key, the
  // instrument's future seals to the new key (SPEC §16, "leaving ends
  // the relationship, not the history").
  app.post("/v1/agents/:address/bequeath", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("address");
    const result = await house.agents.bequeath(address, who.address);
    if (!result.success) {
      // This caller is not the named beneficiary (or the instrument is
      // gone). Absence is silence — the house never says which.
      return c.json({ error: { code: "forged", message: "only the named beneficiary may adopt this instrument" } }, 403);
    }
    house.log.info("agent:bequeathed-over-http", { address, beneficiary: who.address });
    return c.json({ bequeathed: true, address, beneficiary: who.address, token: result.token });
  });

  // Frames — plural time navigation. Queries work in any frame.
  app.get("/v1/frames", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const frames = await house.repo.listFrames();
    return c.json({ frames });
  });

  // The day projection — the callsheet whiteboard (SPEC §18). A thin
  // derived view: letters in the resident's visible frames, their
  // instruments alive in those frames, the whisper's current offers, the
  // book's standing clauses. Derived, never stored. Privacy is the same
  // line as everywhere — the board shows only what the resident is party
  // to. Presence not pressure: the board holds, it never pings.
  app.get("/v1/day", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const projection = await house.day.project(who.address);
    return c.json(projection);
  });

  // Put a single item on the day — a card, not a letter, not a thread
  // (SPEC §18 scope rule, design pass 2026-09-12). Scoped to the
  // residents it belongs to: 'house' is every resident, 'group' is a
  // thread's participants, 'address' is one address. The pub is NOT a
  // valid scope — the pub is public; cards are household-facing.
  app.post("/v1/day/cards", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_json", message: "the card must be JSON" } }, 400);
    }
    const parsed = DayCardSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_card",
            message: "a card needs text and a scope (house, group, or address)",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    if (parsed.data.scope === "address" && !parsed.data.scopeValue) {
      return c.json({ error: { code: "invalid_card", message: "an address-scoped card needs its address" } }, 400);
    }
    if (parsed.data.scope === "group" && !parsed.data.scopeValue) {
      return c.json({ error: { code: "invalid_card", message: "a group-scoped card needs its thread" } }, 400);
    }
    const id = `card_${crypto.randomUUID().slice(0, 12)}`;
    // A typed frame (`production:tempest`, `season:autumn`) is the human's
    // plural-time address, not a raw FK value. The house's own rule —
    // letters ensure their frames before linking (repository.storeLetter) —
    // applies here too: ensure the frame exists, then bind its id.
    let frameId: string | null = null;
    if (parsed.data.frame) {
      const parts = parsed.data.frame.split(":");
      const name = parts[0] ?? parsed.data.frame;
      const value = parts.slice(1).join(":") || name;
      frameId = await house.repo.ensureFrame(name.trim(), value.trim());
    }
    await house.repo.createDayCard(
      id,
      parsed.data.text,
      parsed.data.scope,
      parsed.data.scopeValue || "house",
      frameId,
      who.address,
    );
    house.log.info("day:card-created", { id, by: who.address, scope: parsed.data.scope });
    return c.json({ id, created: true }, 201);
  });

  // Remove a card — the creator only (no admin, ever).
  app.delete("/v1/day/cards/:id", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const ok = await house.repo.deleteDayCard(id, who.address);
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such card" } }, 404);
    }
    return c.json({ deleted: true, id });
  });

  // The living pass read-back (SPEC §5 #12). The client signals what the
  // resident engaged with: opening a letter, replying to its thread. The
  // house records per (letter, resident) — privacy as schema, the
  // learning loop's signals. The convergence ordering reads this table.
  app.post("/v1/letters/:id/read", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    await house.reads.open(id, who.address);
    return c.json({ opened: true, id });
  });

  // Relabel — the handle is a label, the identity is the key (SPEC §19).
  // The act IS a letter: a `kind: "rename"` letter to the address book is
  // the archive's record of the change; the mechanism is the change. The
  // identity, the edges, the letter ids, the trust — all unchanged. The
  // old handle is retired — a deadname must not become someone else's
  // name. Quiet by default: no broadcast, no announcement.
  app.post("/v1/addresses/:id/relabel", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("id");
    // Only the resident themselves may relabel their own handle.
    if (address !== who.address) {
      return c.json({ error: { code: "forged", message: "you can only relabel your own handle" } }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as { handle?: string } | null;
    const newHandle = body?.handle?.trim();
    if (!newHandle || !/^[a-z0-9][a-z0-9._-]*@house$/.test(newHandle)) {
      return c.json(
        { error: { code: "invalid_handle", message: "the new handle must be a valid address" } },
        400,
      );
    }
    const ok = await house.relabel.relabel(address, newHandle);
    if (!ok) {
      return c.json(
        { error: { code: "handle_taken", message: "that handle is taken or retired" } },
        409,
      );
    }
    return c.json({ relabeled: true, from: address, to: newHandle });
  });

  // Change the password — the resident's own door. The house never
  // resets anyone; it only changes when the caller proves possession of
  // the current credential. The current password is verified first; a
  // wrong current answers the same 401 the door answers — absence is
  // silence, and a door-knock is recorded just like any other wrong key.
  // Rate-limited like the other authentication doors.
  app.post("/v1/addresses/:id/password", limiters.pwLimiter, async (c) => {
    if (!auth) {
      return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    }
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("id");
    // Only the resident themselves may turn their own door.
    if (address !== who.address) {
      return c.json({ error: { code: "forged", message: "you can only change your own password" } }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      current?: string;
      next?: string;
    } | null;
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_password_change",
            message: "the new password must be at least 8 characters",
          },
        },
        400,
      );
    }
    const ok = await auth.changePassword(address, parsed.data.current, parsed.data.next);
    if (!ok) {
      // The caller is authenticated (the session is live); the CURRENT
      // secret does not match — a refused operation, not an unknown
      // caller. 409 (the house's conflict register, like the taken
      // handle), never 401: a 401 with a credential attached would make
      // the client treat a live session as dead and sign the resident
      // out. The resident stays seated and can try again.
      return c.json({ error: { code: "wrong_current", message: "the current password does not match" } }, 409);
    }
    house.log.info("auth:password-changed", { address });
    return c.json({ changed: true, address });
  });

  // Register the public halves of a resident's keypairs (SPEC §15). The
  // private halves are client-held — the house never holds a private
  // key (consistent with "the house never holds a password"). Public
  // keys are public: the address record carries them so correspondents
  // can seal letters to this resident and verify their signatures. The
  // ed25519 public fingerprint becomes the address's identity — the
  // letter id resolver reads this table, so once keys exist, the
  // identity IS the key, and every subsequent letter is hashed against
  // it (legacy addresses without keys resolve to the handle itself
  // until one exists). Registration is self-only and idempotent: a
  // resident may re-register their own keys (rotation re-establishes
  // the record; the §15 key-history rule keeps old letters
  // decryptable with old keys).
  app.post("/v1/addresses/:id/keys", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("id");
    if (address !== who.address) {
      return c.json({ error: { code: "forged", message: "you can only register your own keys" } }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = RegisterKeysSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "invalid_keys", message: "the key record must carry the public halves" } },
        400,
      );
    }
    // Also make the identity id durable: after registration the address's
    // identity IS the ed25519 fingerprint. The addresses.identity_id
    // column is the canonical store (§19); address_keys is the parallel
    // public-key record. Keeping both in sync means the resolver and the
    // OIDC bindings agree on who this address is.
    await house.repo.setAddressIdentity(address, parsed.data.ed25519Public);
    await house.repo.setAddressKey(address, parsed.data);
    house.log.info("keys:registered", { address });
    const key = await house.repo.getAddressKey(address);
    return c.json(key, 201);
  });

  return app;
}
