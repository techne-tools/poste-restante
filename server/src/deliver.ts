/**
 * Deliver a letter to the house. Shared by the Hono letter server and the
 * MCP server so both protocol faces behave identically:
 *
 *   1. Ingest (idempotent — the same letter is stored once).
 *   2. A house letter (kind `system` from `house@house`) surfaces in the
 *      whisper — correspondence, not metadata.
 *   3. Writing back is the strongest signal: a letter in a whispered thread
 *      marks the whisper replied.
 */
import type { House } from "./house.js";
import type { LetterInput } from "./schemas.js";
import { AgentService } from "./agents/service.js";

export interface DeliverResult {
  letterId: string;
  created: boolean;
  /** True when a sealed letter's signature failed verification. */
  rejected?: boolean;
  /** Which silence it was — the door says it rather than collapsing them. */
  rejectionReason?: RejectionReason;
}

/** The reasons a letter can be refused at the signature/kind gate. */
export type RejectionReason = "unsigned" | "bad_signature" | "frame_mismatch";

/**
 * The answer a rejection deserves, as data rather than as route prose.
 *
 * Three silences, told apart: a keyletter whose frame carries NO signature is
 * a different fact from one that does not verify, and a kind that does not
 * match its body is a third. Answering all three with "the signature does not
 * verify" would be the house guessing at what it actually knows.
 *
 * Exported so the mapping is testable without a live house — the route is a
 * thin caller, and the copy lives where it can be read in one place.
 */
export function rejectionAnswer(reason: RejectionReason | undefined): {
  status: 400;
  code: string;
  message: string;
} {
  switch (reason) {
    case "unsigned":
      return {
        status: 400,
        code: "keyletter_unsigned",
        message: "a keyletter must carry a signature over its own id — this one carries none",
      };
    case "frame_mismatch":
      return {
        status: 400,
        code: "invalid_letter",
        message: "a keyletter is its key frame — the kind and the body must name the same thing",
      };
    default:
      return {
        status: 400,
        code: "invalid_signature",
        message: "the letter's signature does not verify",
      };
  }
}

export async function deliverLetter(house: House, letter: LetterInput): Promise<DeliverResult> {
  // The id is derived from the envelope+body; a caller-supplied id is
  // ignored (the hash is the identity). Strip it before ingest.
  const { id: _ignored, ...clean } = letter;
  const { letterId, created, rejected, rejectionReason } = await house.pipeline.ingest(clean);
  if (rejected) return { letterId, created: false, rejected: true, rejectionReason };

  if (created && letter.envelope.kind === "system" && letter.envelope.from === "house@house") {
    const summary = letter.body.content.slice(0, 200);
    await house.whisper.surfaceHouseLetter(letterId, letter.envelope.thread, summary);
  }
  // An agent is born a letter (SPEC §16): a `kind: "agent"` letter to
  // agents@house. The house ingests it, validates the scope, mints the
  // address, the token, and the keypairs, and writes the scope record.
  // The birth letter is the archive's record of the will.
  if (created && letter.envelope.kind === "agent" && letter.envelope.to.includes(AgentService.AGENTS_ADDRESS)) {
    try {
      const { address, token } = await house.agents.birth(letter, letterId);
      house.log.info("agent:born", { address, creator: letter.envelope.from });
      // The token is shown once — the capability to act as the address.
      // It is stored only as a hash; the plaintext lives in this log line
      // for the operator to capture, exactly like an invite code.
      house.log.info("agent:token", { address, token });
    } catch (err) {
      house.log.error("agent:birth-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (created) {
    await house.whisper.recordReply(letter.envelope.thread);
  }

  return { letterId, created };
}
