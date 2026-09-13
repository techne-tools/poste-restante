/**
 * The quiet explanation — the house's reasoning on a surface.
 *
 * Locked here: the why-note renders as a details block (never a popup,
 * never a hover — presence not pressure), the door-word is the
 * machine's own register, and the archive, the composer, and the book
 * each carry the distilled reasoning for the surface they offer. The
 * data-driven surfaces (Archive, Book) render loading states in a static
 * render, so their notes are pinned in the source where they live.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function source(name: string): string {
  return readFileSync(join(here, "views", name), "utf8");
}

describe("the why-note — the house's reasoning, distilled", () => {
  it("is a details block, not a popup or a hover", async () => {
    const { default: WhyNote } = await import("./components/WhyNote");
    const html = renderToStaticMarkup(
      <WhyNote summary="why the frames">the residents' time is plural</WhyNote>,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).not.toMatch(/onMouseEnter|onMouseOver|onFocus|title=/);
  });

  it("grounds the archive's frames in plural time", () => {
    const src = source("Archive.tsx");
    expect(src).toContain("why the frames");
    expect(src).toContain("the residents' time is plural");
    expect(src).toContain("dimming, never");
  });

  it("grounds the seal's trade in the sharing, not the content", () => {
    const src = source("Compose.tsx");
    expect(src).toContain("what the seal does");
    expect(src).toContain("the sharing the circulation");
    expect(src).toContain("not indexed, not searched, not whispered");
  });

  it("grounds the household acts in the supported commons", () => {
    const src = source("Book.tsx");
    expect(src).toContain("how the household decides");
    expect(src).toContain("is supported, never");
    expect(src).toContain("no one is master; everyone can be inscribed");
  });
});
