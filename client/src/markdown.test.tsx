/**
 * The letter's markdown renderer — unit tests.
 *
 * The renderer is the one piece of the letter surface with real logic
 * (block parsing + inline tokenising), so it earns unit tests. The views
 * themselves are verified by the E2E run against the live house.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";

function html(content: string): string {
  return renderToStaticMarkup(<>{renderMarkdown(content)}</>);
}

describe("renderMarkdown — blocks", () => {
  it("renders a paragraph", () => {
    expect(html("the letter waits")).toBe("<p>the letter waits</p>");
  });

  it("renders headings at three levels", () => {
    expect(html("# one\n\n## two\n\n### three")).toBe(
      "<h1>one</h1><h2>two</h2><h3>three</h3>",
    );
  });

  it("renders a blockquote", () => {
    expect(html("> the decision is in the archive")).toBe(
      "<blockquote>the decision is in the archive</blockquote>",
    );
  });

  it("renders a list as one <ul>", () => {
    expect(html("- one\n- two\n- three")).toBe(
      "<ul><li>one</li><li>two</li><li>three</li></ul>",
    );
  });

  it("keeps blank lines between blocks", () => {
    expect(html("first\n\nsecond")).toBe("<p>first</p><p>second</p>");
  });
});

describe("renderMarkdown — inline", () => {
  it("renders bold and italic", () => {
    expect(html("a **bold** and an *italic* word")).toBe(
      "<p>a <strong>bold</strong> and an <em>italic</em> word</p>",
    );
  });

  it("renders inline code", () => {
    expect(html("run `npm run test` now")).toBe(
      "<p>run <code>npm run test</code> now</p>",
    );
  });

  it("does not parse ** inside code as emphasis", () => {
    expect(html("`a **b** c`")).toBe("<p><code>a **b** c</code></p>");
  });

  it("renders a link", () => {
    expect(html("[the archive](/v1/archive)")).toBe(
      '<p><a href="/v1/archive">the archive</a></p>',
    );
  });

  it("leaves unknown punctuation literal — no leaked asterisks", () => {
    expect(html("2 * 3 = 6")).toBe("<p>2 * 3 = 6</p>");
  });

  it("renders inline inside list items", () => {
    expect(html("- a **bold** item")).toBe(
      "<ul><li>a <strong>bold</strong> item</li></ul>",
    );
  });
});
