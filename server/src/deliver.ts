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

export interface DeliverResult {
  letterId: string;
  created: boolean;
}

export async function deliverLetter(house: House, letter: LetterInput): Promise<DeliverResult> {
  // The id is derived from the envelope+body; a caller-supplied id is
  // ignored (the hash is the identity). Strip it before ingest.
  const { id: _ignored, ...clean } = letter;
  const { letterId, created } = await house.pipeline.ingest(clean);

  if (created && letter.envelope.kind === "system" && letter.envelope.from === "house@house") {
    const summary = letter.body.content.slice(0, 200);
    await house.whisper.surfaceHouseLetter(letterId, letter.envelope.thread, summary);
  }
  if (created) {
    await house.whisper.recordReply(letter.envelope.thread);
  }

  return { letterId, created };
}
