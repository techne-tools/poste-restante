/**
 * The whisper kinds — every one has its own label.
 *
 * The whisper sidebar names each kind in the house's own words ("the
 * house", "a quiet thread", …). This renders the sidebar once per kind and
 * asserts every kind produces a distinct, non-empty label — so a new kind
 * cannot ship as a blank or as a copy of another. The kind list is read from
 * the client's own `Whisper["kind"]` union, which `kinds.test.ts` holds to
 * the server's.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WhisperSidebar from "./components/WhisperSidebar";
import type { Whisper } from "./api";

const here = dirname(fileURLToPath(import.meta.url));
const noop = () => {};

function kinds(): string[] {
  const api = readFileSync(join(here, "api", "types.ts"), "utf8");
  const start = api.indexOf("interface Whisper {");
  const block = api.slice(start, api.indexOf("targetThread", start));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function whisper(kind: string): Whisper {
  return {
    id: `w_${kind}`,
    letterId: null,
    kind: kind as Whisper["kind"],
    targetThread: null,
    relatedLetterId: null,
    targetFrame: null,
    targetAddress: null,
    citedClause: null,
    citedExcerpt: null,
    summary: "the house has something to say",
    reasoning: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    openedAt: null,
    dismissedAt: null,
    repliedAt: null,
  };
}

function labelFor(kind: string): string {
  const html = renderToStaticMarkup(
    <WhisperSidebar
      whispers={[whisper(kind)]}
      onOpen={noop}
      onDismiss={noop}
      onGaps={noop}
      onWriteBack={noop}
      onCite={noop}
    />,
  );
  return /class="kind">([^<]*)</.exec(html)?.[1] ?? "";
}

describe("the whisper kinds — every one has its own label", () => {
  const all = kinds();

  it("reaches every kind (the scan is not vacuous)", () => {
    expect(all.length).toBeGreaterThan(4);
  });

  it("renders a distinct, non-empty label for each", () => {
    const labels = all.map(labelFor);
    expect(labels.filter((l) => l === "")).toEqual([]);
    expect(new Set(labels).size).toBe(all.length);
  });
});
