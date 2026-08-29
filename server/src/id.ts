/**
 * Letter identity. The id is `sha256` of the canonical serialisation of the
 * envelope + body. Two identical letters are the same letter; a changed letter
 * is a new letter. This is the house's deduplication and integrity spine.
 */
import { createHash } from "node:crypto";
import type { Letter } from "./types.js";

/**
 * Canonical serialisation of a letter. Field order is fixed so the hash is
 * stable across processes and platforms. Frames are sorted by (frame, value) so
 * the same set of frames hashes identically regardless of arrival order.
 */
export function canonicalise(letter: Letter): string {
  const frames = [...letter.time.frames]
    .sort((a, b) =>
      a.frame === b.frame ? a.value.localeCompare(b.value) : a.frame.localeCompare(b.frame),
    )
    .map((f) => `${f.frame}=${f.value}`)
    .join(",");

  return JSON.stringify({
    envelope: {
      from: letter.envelope.from,
      to: letter.envelope.to,
      cc: letter.envelope.cc,
      thread: letter.envelope.thread,
      kind: letter.envelope.kind,
      lang: letter.envelope.lang,
      subject: letter.envelope.subject,
    },
    time: {
      gregorian: letter.time.gregorian,
      frames,
    },
    body: {
      format: letter.body.format,
      content: letter.body.content,
    },
  });
}

/** Derive the letter id: sha256 hex of the canonical serialisation. */
export function letterId(letter: Letter): string {
  return createHash("sha256").update(canonicalise(letter)).digest("hex");
}
