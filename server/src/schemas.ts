/**
 * The letter contract — shared zod schemas for the house's protocol faces.
 *
 * The Hono letter server (server.ts) and the MCP server (mcp/server.ts) both
 * speak the CONTRACT: envelope + body, plural time, derived identity. These
 * schemas are the single source of truth so the two faces can't drift.
 */
import { z } from "zod";
import { LETTER_KINDS } from "./types.js";
import { stripClauseFrontmatter } from "./book/frontmatter.js";
import type { StoredLetterRow } from "./db/repository.js";

export const FrameSchema = z.object({
  frame: z.string().min(1).max(100),
  value: z.string().min(1).max(200),
});

/**
 * An email/resident address string. Follows standard email addressing:
 * strictly disallows CRLF or null bytes to prevent RFC 5322 header injection.
 */
export const AddressStringSchema = z
  .string()
  .min(1)
  .max(320)
  .refine((s) => !/[\r\n\0]/.test(s), {
    message: "address must not contain control characters or newlines",
  });

export const EnvelopeSchema = z.object({
  from: AddressStringSchema,
  to: z.array(AddressStringSchema).min(1).max(500),
  cc: z.array(AddressStringSchema).max(500).default([]),
  thread: z.string().min(1).max(200),
  kind: z.enum(LETTER_KINDS),
  lang: z.string().min(1).max(35).default("en-AU"),
  subject: z.string().max(998).default(""),
});

export const TimeSchema = z.object({
  gregorian: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "gregorian must be an ISO-8601 timestamp",
  }),
  frames: z.array(FrameSchema).default([]),
});

export const BodySchema = z.object({
  format: z.literal("markdown"),
  content: z.string().max(25 * 1024 * 1024),
});

/**
 * The sealed letter (SPEC §15) — the cryptographic horizon. A sealed
 * letter's body is ciphertext; the house stores it, never reads it. The
 * envelope keeps the pointers (thread, frames, addresses); the subject
 * moves into the body (the one envelope field that is pure content).
 *
 * `sealed: true` + `recipients` (the age recipients the body was sealed
 * to) + `signature` (ed25519 over the letter id, base64url). The house
 * verifies the signature on ingest and at rest; it never embeds, FTSes,
 * or whispers sealed bodies.
 */
export const SealedBodySchema = z.object({
  format: z.literal("sealed"),
  content: z.string().max(25 * 1024 * 1024),
  recipients: z.array(z.string()).min(1).max(50),
  signature: z.string().min(1),
});

export const LetterSchema = z.object({
  // The id is derived from the envelope+body. A caller-supplied id is
  // accepted for contract compatibility but ignored — the hash is the identity.
  id: z.string().optional(),
  envelope: EnvelopeSchema,
  time: TimeSchema,
  body: z.union([BodySchema, SealedBodySchema]),
});

export const AddressSchema = z.object({
  names: z.array(z.string()).default([]),
  pronouns: z.string().nullable().default(null),
});

/**
 * The invite redemption — the guest's door into the house (SPEC §5.7).
 * Address must be a participant of the invite letter; the code and the
 * password are the guest's own. The code is the one-time key; the password
 * is the credential the guest sets for themselves.
 */
export const RedeemSchema = z.object({
  address: z.string().min(1),
  code: z.string().min(1),
  password: z.string().min(8),
});

/**
 * The password change — the resident's own door (SPEC §5, auth). The house
 * never resets anyone; it only changes when the caller proves possession
 * of the current credential. The current password is verified first; a
 * wrong current answers null (the route decides — 401, absence is
 * silence). The new password is min-8, the same rule as redemption.
 */
export const ChangePasswordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(8),
});

/**
 * The key registration (SPEC §15) — the public halves of a resident's
 * age + ed25519 keypairs. The private halves are client-held; the house
 * stores only these (public keys are public). `ed25519Public` is the
 * address's identity — the letter id resolver reads this table, so a
 * registered key changes how every subsequent letter is hashed (the
 * identity IS the key; legacy addresses without keys resolve to the
 * handle itself until one exists).
 */
export const RegisterKeysSchema = z.object({
  ageRecipient: z.string().min(1),
  ed25519Public: z.string().min(1),
  recoveryAgeRecipient: z.string().nullable().default(null),
});

/**
 * The house book — an act is a letter (SPEC §5.8). The role is stated
 * will; the house enforces what is declared, never what is inferred.
 * The vocabulary is the household's own — consent-forward, not
 * parliamentary: offer (a norm is a gift the household may accept),
 * develop (it grows), stop (a safe word — no and yes are equally
 * significant), support (standing with), set aside (shelved, not
 * destroyed). An offer opens a thread; every other role continues one
 * (`continues`). An offer may carry `reverses` (a reversal offer) and
 * `binding` (a bound door — v1: pub@house.is_public only).
 */
export const ClauseActionSchema = z.object({
  role: z.enum(["offer", "develop", "stop", "support", "set aside"]),
  continues: z.string().min(1).optional(),
  reverses: z.string().min(1).optional(),
  binding: z
    .object({
      door: z.string().min(1),
      value: z.boolean(),
    })
    .optional(),
  text: z.string().optional(),
});

export type LetterInput = z.infer<typeof LetterSchema>;

/** Map a stored row back to the contract letter shape. Shared by the Hono
 * letter server and the MCP server so both protocol faces return the same
 * letter shape. */
export function toLetter(row: StoredLetterRow) {
  return {
    id: row.id,
    envelope: {
      from: row.from_addr,
      to: row.to_addrs,
      cc: row.cc_addrs,
      thread: row.thread_id,
      kind: row.kind as import("./types.js").LetterKind,
      lang: row.lang,
      subject: row.subject,
    },
    time: {
      gregorian: row.received_at.toISOString(),
      frames: row.frames,
    },
    body: row.sealed
      ? {
          format: "sealed" as const,
          content: row.body,
          // The house stores the ciphertext and the signature, never the
          // recipient list (data minimisation — the reader needs only
          // their own key and the envelope). Served as an empty list;
          // inbound delivery (SealedBodySchema) still requires the
          // recipients because delivery must know whom to seal to.
          recipients: [],
          signature: row.signature ?? "",
        }
      : {
          format: "markdown" as const,
          // A clause letter's body begins with the stated-will frontmatter
          // (the role/continues block). The reading surface never shows it —
          // the act is the letter, the text is the clause. Stripped here, at
          // the shared mapper, so every protocol face (HTTP + MCP) returns
          // letters that read as letters. Derivation keeps stripping for the
          // engine's own use; the archive stores the full body.
          content: row.kind === "clause" ? stripClauseFrontmatter(row.body) : row.body,
        },
    receivedAt: row.received_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    pinnedBy: row.pinned_by ?? null,
  };
}
