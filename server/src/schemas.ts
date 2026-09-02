/**
 * The letter contract — shared zod schemas for the house's protocol faces.
 *
 * The Hono letter server (server.ts) and the MCP server (mcp/server.ts) both
 * speak the CONTRACT: envelope + body, plural time, derived identity. These
 * schemas are the single source of truth so the two faces can't drift.
 */
import { z } from "zod";
import { LETTER_KINDS } from "./types.js";
import type { StoredLetterRow } from "./db/repository.js";

export const FrameSchema = z.object({
  frame: z.string().min(1),
  value: z.string().min(1),
});

export const EnvelopeSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).default([]),
  thread: z.string().min(1),
  kind: z.enum(LETTER_KINDS),
  lang: z.string().min(1).default("en-AU"),
  subject: z.string().default(""),
});

export const TimeSchema = z.object({
  gregorian: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "gregorian must be an ISO-8601 timestamp",
  }),
  frames: z.array(FrameSchema).default([]),
});

export const BodySchema = z.object({
  format: z.literal("markdown"),
  content: z.string(),
});

export const LetterSchema = z.object({
  // The id is derived from the envelope+body. A caller-supplied id is
  // accepted for contract compatibility but ignored — the hash is the identity.
  id: z.string().optional(),
  envelope: EnvelopeSchema,
  time: TimeSchema,
  body: BodySchema,
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
      kind: row.kind,
      lang: row.lang,
      subject: row.subject,
    },
    time: {
      gregorian: row.received_at.toISOString(),
      frames: row.frames,
    },
    body: {
      format: "markdown" as const,
      content: row.body,
    },
    receivedAt: row.received_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    pinnedBy: row.pinned_by ?? null,
  };
}
