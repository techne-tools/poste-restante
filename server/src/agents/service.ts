/**
 * AgentService — instruments, not servants (SPEC §16).
 *
 * An agent is born a letter: a `kind: "agent"` letter to `agents@house`
 * whose body is the task, the reach, the lifespan. The house ingests it,
 * validates the scope, mints the address, the token, the age + ed25519
 * keypairs (§15), and a server-side scope record. The agent's history is
 * the archive. Its state is the archive. It has no other memory.
 *
 * The reach is enumerated, not discoverable. An agent's world is exactly
 * three doors: its creator (always party), an opt-in group (a thread),
 * and the pub (a grant, default closed). The server enforces who the
 * agent may address on every write — `canAddress` is the load-bearing
 * check, called by the deliver path before an agent's letter is stored.
 *
 * The house enforces reach, not content: the scope letter cannot be
 * sealed (the house must read the task it is policing), but the agent's
 * findings may be sealed letters.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import type { PostgresRepository } from "../db/repository.js";
import type { IngestionPipeline } from "../pipeline/pipeline.js";
import { generateResidentKeypair } from "../crypto/keys.js";
import type { Letter } from "../types.js";

/** The agent's birth letter body — the will. */
export interface AgentBirth {
  /** The task text — the house must read what it is policing. */
  task: string;
  /** The lifespan frame (plural time). When the frame closes, the agent dies. */
  lifespan?: string;
  /** The opt-in group: a thread the agent may address. */
  group?: string;
  /** The pub grant: default closed. */
  pub?: boolean;
  /** A resident who may inherit the instrument on departure. */
  beneficiary?: string;
}

/** The scope record — the instrument's constitution. */
export interface AgentScope {
  address: string;
  creator: string;
  kind: "house" | "portal";
  task: string;
  lifespanFrame: string | null;
  groupThread: string | null;
  pubGrant: boolean;
  beneficiary: string | null;
  diedAt: Date | null;
}

/** The agent's doors — the enumerated reach. */
export interface AgentDoors {
  creator: string;
  groupThread: string | null;
  pubGrant: boolean;
}

export class AgentService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly repo: PostgresRepository,
    private readonly pipeline: IngestionPipeline,
    private readonly log: Logger,
  ) {}

  /** The address the birth letters go to. */
  static readonly AGENTS_ADDRESS = "agents@house";

  /**
   * Ingest a birth letter and mint the agent. The act IS the letter: the
   * archive keeps the will; the house validates the scope, mints the
   * address, the token, and the keypairs, and writes the scope record.
   * Returns the minted agent's address and one-time token.
   */
  async birth(letter: Letter, letterId: string): Promise<{ address: string; token: string }> {
    const creator = letter.envelope.from;
    const body = letter.body.format === "markdown" ? letter.body.content : "";
    const birth: AgentBirth = this.parseBirth(body);

    // The address is derived from the task — a stable, readable instrument
    // name. The house mints it; the creator never supplies it.
    const slug = birth.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent";
    const address = `${slug}@house`;

    // The token — shown once, stored as a hash. The capability to act as
    // the address.
    const token = `pr_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");

    // The agent's keypairs (§15) — the house holds the public halves; the
    // private halves are the agent's own (house agents: the house's
    // instrumentation; portal agents: the portal's).
    const keys = await generateResidentKeypair(address);

    // Materialise the address — the agent is a resident of the house, an
    // instrument in the address book, flat and marked as such.
    await this.pool.query(
      `INSERT INTO addresses (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [address],
    );

    // The opt-in group is a thread — ensure it exists (a group IS a
    // thread; participation is already derived from letter_addresses).
    if (birth.group) {
      await this.pool.query(
        `INSERT INTO threads (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [birth.group],
      );
    }

    await this.pool.query(
      `INSERT INTO agents
        (address, creator, kind, birth_letter_id, task, lifespan_frame,
         group_thread, pub_grant, beneficiary, token_hash, age_recipient, ed25519_public)
      VALUES ($1, $2, 'portal', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        address,
        creator,
        letterId,
        birth.task,
        birth.lifespan ?? null,
        birth.group ?? null,
        birth.pub ?? false,
        birth.beneficiary ?? null,
        tokenHash,
        keys.public.ageRecipient,
        keys.public.ed25519Public,
      ],
    );

    this.log.info("agent:born", { address, creator });
    return { address, token };
  }

  /** Parse the birth letter's body — the will. Markdown frontmatter-ish:
   *  the first line is the task; optional `lifespan:`, `group:`, `pub:`,
   *  `beneficiary:` lines follow. The house reads what it is policing. */
  parseBirth(body: string): AgentBirth {
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const task = lines[0] ?? "";
    const birth: AgentBirth = { task };
    for (const line of lines.slice(1)) {
      const [key, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (key === "lifespan" && value) birth.lifespan = value;
      if (key === "group" && value) birth.group = value;
      if (key === "pub" && value) birth.pub = value === "true" || value === "1";
      if (key === "beneficiary" && value) birth.beneficiary = value;
    }
    return birth;
  }

  /** The agent's doors — the enumerated reach. */
  async doors(address: string): Promise<AgentDoors | null> {
    const { rows } = await this.pool.query<{
      creator: string;
      group_thread: string | null;
      pub_grant: boolean;
    }>(
      `SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL`,
      [address],
    );
    const row = rows[0];
    if (!row) return null;
    return { creator: row.creator, groupThread: row.group_thread, pubGrant: row.pub_grant };
  }

  /**
   * The load-bearing check: may this agent address this recipient? The
   * reach is enumerated — exactly three doors. Called by the deliver
   * path before an agent's letter is stored. The house enforces reach,
   * never content.
   */
  async canAddress(agent: string, recipient: string): Promise<boolean> {
    const doors = await this.doors(agent);
    if (!doors) return false;
    // Door 1: the creator — always party.
    if (recipient === doors.creator) return true;
    // Door 2: the opt-in group — a thread. Participation is already
    // derived from letter_addresses; the agent may address the group.
    if (doors.groupThread && recipient === doors.groupThread) return true;
    // Door 3: the pub — a grant, default closed.
    if (doors.pubGrant && recipient === "pub@house") return true;
    return false;
  }

  /** Is this address an agent? */
  async isAgent(address: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM agents WHERE address = $1 AND died_at IS NULL`,
      [address],
    );
    return rows.length > 0;
  }

  /** Kill an agent — the frame closed, the creator left, the clause
   *  reversed. The token is revoked; the agent stops waking. The archive
   *  keeps the history. */
  async kill(address: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE agents SET died_at = now(), token_hash = NULL WHERE address = $1 AND died_at IS NULL`,
      [address],
    );
    if ((res.rowCount ?? 0) > 0) {
      this.log.info("agent:died", { address });
      return true;
    }
    return false;
  }

  /**
   * The death sweep — tasks die (SPEC §16, "no zombies").
   *
   * An agent whose lifespan frame has been quiet for the activity window
   * (30 days — the house's established active-frame derivation, the same
   * cutoff the whisper and the mailbox use) has outlived its task: the
   * frame closed. The agent writes its final letter first — a letter
   * from the instrument to its creator, waiting in the mailbox like any
   * other finding (findings are labour; labour waits; presence not
   * pressure, no whisper) — then the token is revoked and it stops
   * waking.
   *
   * Restart-safe: the sweep is idempotent per agent. If the final letter
   * cannot be stored, the agent is not killed — the next sweep retries.
   * If the kill fails after the letter is stored, the next sweep's final
   * letter is the same deterministic letter (same envelope+body → same
   * id), an idempotent no-op, and the kill retries.
   */
  async sweepExpired(
    now = new Date(),
    activityWindowMs = 30 * 24 * 60 * 60 * 1000,
  ): Promise<string[]> {
    const cutoff = new Date(now.getTime() - activityWindowMs);
    const { rows } = await this.pool.query<{
      address: string;
      creator: string;
      task: string;
      lifespan_frame: string;
    }>(
      `SELECT a.address, a.creator, a.task, a.lifespan_frame
       FROM agents a
       WHERE a.died_at IS NULL AND a.lifespan_frame IS NOT NULL
         AND a.created_at <= $1
         AND NOT EXISTS (
           SELECT 1 FROM letter_frames lf
           JOIN letters l ON l.id = lf.letter_id
           WHERE lf.frame_id = a.lifespan_frame AND l.received_at > $1
         )`,
      [cutoff],
    );

    const killed: string[] = [];
    for (const row of rows) {
      // The final letter — the instrument's own closing word, addressed
      // to its creator. The house writes it on the agent's behalf (the
      // pipeline is the single write path; the agent's token is revoked
      // at the end of this act, so only the house can speak the
      // instrument's last sentence). The thread is derived from the
      // instrument address — deterministic, so a retried sweep writes
      // the same letter (same envelope+body → same id, an idempotent
      // no-op), and the agent's closing words stay in one place.
      const finalLetter: Letter = {
        envelope: {
          from: row.address,
          to: [row.creator],
          cc: [],
          thread: `th_agent_${row.address.split("@")[0]}`,
          kind: "letter",
          lang: "en-AU",
          subject: "",
        },
        time: { gregorian: now.toISOString(), frames: [{ frame: "agent", value: "final" }] },
        body: {
          format: "markdown",
          content: `${row.task.trim()}\n\nmy frame closed — this task is done.`,
        },
      };
      try {
        await this.pipeline.ingest(finalLetter);
      } catch (err) {
        this.log.error("agent:final-letter-failed", {
          address: row.address,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // do not kill — the next sweep retries
      }
      const died = await this.kill(row.address);
      if (died) killed.push(row.address);
    }
    if (killed.length > 0) {
      this.log.info("agent:sweep", { checked: rows.length, killed: killed.length });
    } else if (rows.length > 0) {
      this.log.info("agent:sweep", { checked: rows.length, killed: 0 });
    }
    return killed;
  }
}
