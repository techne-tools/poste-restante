/**
 * The letter kinds — every one renders its own quiet mark.
 *
 * `KindTag` is the letter's kind identity. This renders it once per kind and
 * asserts each kind shows its own word and a real glyph — never the fallback
 * dot — and that the only glyph two kinds share is the deliberate shelf pair
 * (`shelve`/`unshelve`, one mark; the word carries the direction). The kind
 * list is read from the server's `LETTER_KINDS`.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import KindTag from "./KindTag";

const here = dirname(fileURLToPath(import.meta.url));

function letterKinds(): string[] {
  const types = readFileSync(join(here, "../../server/src/types.ts"), "utf8");
  const start = types.indexOf("export const LETTER_KINDS = [");
  const block = types.slice(start, types.indexOf("]", start));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function render(kind: string): { glyph: string; word: string } {
  const html = renderToStaticMarkup(<KindTag kind={kind} />);
  const glyph = /class="glyph"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
  const word =
    /<span class="glyph"[^>]*>[^<]*<\/span>([^<]*)<\/span>/.exec(html)?.[1] ?? "";
  return { glyph, word };
}

describe("the letter kinds — every one renders its own mark", () => {
  const kinds = letterKinds();

  it("reaches every kind (the scan is not vacuous)", () => {
    expect(kinds.length).toBeGreaterThan(10);
  });

  it("shows each kind's own word, never the fallback dot", () => {
    const bad: string[] = [];
    for (const kind of kinds) {
      const { glyph, word } = render(kind);
      if (glyph === "·" || word !== kind) bad.push(`${kind} → glyph "${glyph}", word "${word}"`);
    }
    expect(bad).toEqual([]);
  });

  it("shares a glyph only where it is deliberate — the shelf pair", () => {
    const byGlyph = new Map<string, string[]>();
    for (const kind of kinds) {
      const { glyph } = render(kind);
      byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), kind]);
    }
    const shared = [...byGlyph.entries()].filter(([, ks]) => ks.length > 1);
    for (const [glyph, ks] of shared) {
      expect(glyph).toBe("▽");
      expect([...ks].sort()).toEqual(["shelve", "unshelve"]);
    }
  });
});
