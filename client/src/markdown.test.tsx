/**
 * The letter's markdown renderer — unit tests.
 *
 * The renderer is the one piece of the letter surface with real logic
 * (block parsing + inline tokenising), so it earns unit tests. The views
 * themselves are verified by the E2E run against the live house.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, snippet, snippetForLetter } from "./markdown";

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

  it("renders a relative link", () => {
    expect(html("[the archive](/v1/archive)")).toBe(
      '<p><a href="/v1/archive">the archive</a></p>',
    );
  });

  it("renders external https and mailto links with safe attributes", () => {
    expect(html("[read more](https://example.org)")).toBe(
      '<p><a href="https://example.org" target="_blank" rel="noopener noreferrer">read more</a></p>',
    );
    expect(html("[write us](mailto:you@house.test)")).toBe(
      '<p><a href="mailto:you@house.test" target="_blank" rel="noopener noreferrer">write us</a></p>',
    );
  });

  it("neutralises dangerous script execution schemes like javascript: and data:", () => {
    expect(html("[exploit](javascript:alert(1))")).toBe("<p>exploit</p>");
    expect(html("[payload](data:text/html,<script>alert(1)</script>)")).toBe(
      "<p>payload</p>",
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

describe("snippet — the row's plain-text first line", () => {
  it("strips markdown markers and collapses whitespace", () => {
    expect(snippet("## The **gap**\n\n> the decision is in the archive")).toBe(
      "The gap the decision is in the archive",
    );
  });

  it("turns links into their text", () => {
    expect(snippet("see [the archive](/v1/archive) for the rest")).toBe(
      "see the archive for the rest",
    );
  });

  it("caps at the default 120 characters", () => {
    expect(snippet("x".repeat(200))).toHaveLength(120);
  });

  it("backs off to the last full stop instead of cutting mid-sentence", () => {
    const long =
      "I'm trying to recapture a vibe. Only, when i was doing it, it wasn't called a vibe because we didn't know shit. I used to";
    const out = snippet(long);
    expect(out.endsWith("shit.")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it("backs off to ? and ! as sentence ends too", () => {
    const q = "Is the house holding? " + "y".repeat(200);
    expect(snippet(q).endsWith("holding?")).toBe(true);
    const e = "The house holds! " + "y".repeat(200);
    expect(snippet(e).endsWith("holds!")).toBe(true);
  });

  it("keeps a closing quote with the sentence end", () => {
    const q = "She said \u201cwait.\u201d " + "y".repeat(200);
    expect(snippet(q).endsWith("\u201d")).toBe(true);
  });

  it("falls back to a hard cut when the window has no sentence end", () => {
    expect(snippet("x".repeat(200))).toHaveLength(120);
    expect(snippet("no stops here " + "y".repeat(200))).toHaveLength(120);
  });
});

describe("snippetForLetter — the list surface never renders ciphertext", () => {
  it("shows a sealed letter as 'sealed letter', never the armor", () => {
    expect(
      snippetForLetter({ body: { format: "sealed", content: "age1ciphertext-armored" } }),
    ).toBe("sealed letter");
  });

  it("snippets an open letter's body as usual", () => {
    expect(
      snippetForLetter({ body: { format: "markdown", content: "## The gap\n\n> held" } }),
    ).toBe("The gap held");
  });
});
