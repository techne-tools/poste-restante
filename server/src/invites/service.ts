/**
 * InviteService — invitation-only membership (SPEC §5.7).
 *
 * Joining the house is a letter, not a CLI ceremony. A resident mints a
 * dormant address (a row in the social graph, no credential) and writes a
 * `kind: "invite"` letter to it. The guest is told about the letter out of
 * band (the house never pushes); redeeming proves possession of the letter —
 * the redeeming address must be a participant (`to`) of that letter — and
 * presents the one-time code. The house then issues a credential the guest
 * sets themselves. The letter stays: it is the opening letter of the
 * correspondence, and the voucher edge (`owner@house wrote to guest@house`)
 * IS the social graph.
 *
 * Privacy as schema: the code lives in the letter body (only the parties of
 * the letter can read it); the `invites` table stores only `code_hash`, never
 * the code. Revocation is just deletion of the letter (the invite row
 * CASCADEs away) — first-class deletion, no revoke flag.
 *
 * Fail closed: every negative path (unknown code, wrong address, spent,
 * expired, already a resident) returns null — the caller answers 404, never
 * 403, and never confirms existence.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { IngestionPipeline } from "../pipeline/pipeline.js";
import { hashPassword, type AuthService } from "../auth/service.js";
import type { Letter } from "../types.js";

/** Human-typable alphabet — no 0/O/1/I/L confusion. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;
const MIN_PASSWORD_LENGTH = 8;

export interface MintedInvite {
  letterId: string;
  /** The one-time code. Printed once; stored only as a hash. */
  code: string;
  address: string;
  createdBy: string;
}

export interface RedeemInput {
  /** The guest's address — must be a participant of the invite letter. */
  address: string;
  /** The one-time code from the letter body. */
  code: string;
  /** The credential the guest sets for themselves. */
  password: string;
}

/** sha256 hex — the only trace of the code the archive keeps. */
export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Generate a human-typable one-time code: XXXX-XXXX-XXXX. */
export function generateInviteCode(): string {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      group += CODE_ALPHABET[bytes[g * CODE_GROUP_LEN + i]! % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export class InviteService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pipeline: IngestionPipeline,
    private readonly auth: AuthService,
  ) {}

  /**
   * Mint an invite. Writes the invite letter (the ingest creates the dormant
   * address + the voucher edge in the social graph) and stores the code hash.
   * Returns the letter id and the code — the code is shown once, never stored.
   *
   * The letter is archived before the invite row: if the invite insert fails
   * the letter remains as a dead invitation the owner can delete (first-class
   * deletion) — no partial state is possible the other way round.
   */
  async mint(createdBy: string, address: string): Promise<MintedInvite> {
    if (await this.auth.hasCredential(address)) {
      throw new Error(`${address} is already a resident of the house`);
    }

    const code = generateInviteCode();
    const letter: Letter = {
      envelope: {
        from: createdBy,
        to: [address],
        cc: [],
        thread: `th_invite_${randomBytes(6).toString("hex")}`,
        kind: "invite",
        lang: "en-AU",
        subject: "an invitation to the house",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "markdown",
        content: [
          `You are invited to the house.`,
          ``,
          `Your address is \`${address}\`. To accept, present this letter with the one-time code:`,
          ``,
          `    ${code}`,
          ``,
          `The code works once.`,
        ].join("\n"),
      },
    };

    const { letterId } = await this.pipeline.ingest(letter);
    await this.pool.query(
      `INSERT INTO invites (letter_id, created_by, code_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (letter_id) DO NOTHING`,
      [letterId, createdBy, hashInviteCode(code)],
    );
    return { letterId, code, address, createdBy };
  }

  /**
   * Redeem an invite. Proves possession (the redeeming address must be a
   * participant of the invite letter) and presents the code: the two factors
   * of the voucher. The claim is atomic — exactly one redemption wins — and
   * the guest's credential is granted in the same transaction.
   *
   * Returns the address on success, or null on every negative path.
   */
  async redeem(input: RedeemInput): Promise<{ address: string } | null> {
    const { address, code, password } = input;
    if (password.length < MIN_PASSWORD_LENGTH) return null;

    const codeHash = hashInviteCode(code.trim().toUpperCase());
    const { rows } = await this.pool.query<{
      letterId: string;
      expiresAt: Date | null;
      redeemedAt: Date | null;
      toAddrs: string[];
    }>(
      `SELECT i.letter_id AS "letterId",
              i.expires_at AS "expiresAt",
              i.redeemed_at AS "redeemedAt",
              l.to_addrs    AS "toAddrs"
       FROM invites i
       JOIN letters l ON l.id = i.letter_id
       WHERE i.code_hash = $1`,
      [codeHash],
    );

    const invite = rows[0];
    if (!invite) return null; // unknown code — the house never confirms existence
    if (!invite.toAddrs.includes(address)) return null; // not the addressee
    if (invite.redeemedAt) return null; // spent — one-time
    if (invite.expiresAt && invite.expiresAt < new Date()) return null; // timed out
    if (await this.auth.hasCredential(address)) return null; // already a resident

    // Atomic claim: the UPDATE is guarded by redeemed_at IS NULL, so a racing
    // second redemption loses and the credential grant never runs for it.
    // Both the claim and the credential land in one transaction.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `UPDATE invites
         SET redeemed_at = now(), redeemed_by = $1
         WHERE letter_id = $2
           AND redeemed_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
        [address, invite.letterId],
      );
      if ((res.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO addresses (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [address],
      );
      await client.query(
        `INSERT INTO credentials (address, kind, secret)
         VALUES ($1, 'password', $2)
         ON CONFLICT (address) DO UPDATE SET kind = 'password', secret = $2`,
        [address, hashPassword(password)],
      );
      await client.query("COMMIT");
      return { address };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
