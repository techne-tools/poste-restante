/**
 * The kind vocabulary — the client and the server agree.
 *
 * The server owns the letter kinds (`LETTER_KINDS`) and the whisper kinds
 * (`WhisperKind`); the client renders them (the `KindTag` glyph, the
 * `Whisper["kind"]` union). They had drifted: `agent` and `rename` letters
 * rendered the fallback dot. This locks the two sides together, so a new
 * kind on the server cannot ship without its identity on the client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = join(here, "../../../server/src");
const srcRoot = join(here, "..");

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`not found: ${from}`);
  return source.slice(start, source.indexOf(to, start));
}

function quoted(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const letterKinds = quoted(
  between(readFileSync(join(serverSrc, "types.ts"), "utf8"), "export const LETTER_KINDS = [", "]"),
);
const whisperServer = quoted(
  between(readFileSync(join(serverSrc, "whisper/service.ts"), "utf8"), "export type WhisperKind =", ";"),
);

const kindTag = readFileSync(join(srcRoot, "components", "KindTag.tsx"), "utf8");
const kindMeta = [
  ...between(kindTag, "const KIND_META", "};").matchAll(/([a-z]+):\s*\{\s*glyph/g),
].map((m) => m[1]!);

const api = readFileSync(join(srcRoot, "api", "types.ts"), "utf8");
const whisperClient = quoted(between(api, "interface Whisper {", "targetThread"));

describe("the kind vocabulary — client and server agree", () => {
  it("every server letter kind has a client glyph, and only those", () => {
    expect(letterKinds.length).toBeGreaterThan(10);
    expect([...kindMeta].sort()).toEqual([...letterKinds].sort());
  });

  it("the client's whisper kinds match the server's", () => {
    expect(whisperServer.length).toBeGreaterThan(4);
    expect([...whisperClient].sort()).toEqual([...whisperServer].sort());
  });
});
