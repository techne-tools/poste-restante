import { describe, it, expect } from "vitest";
import { markdownToText } from "../../src/pipeline/markdown.js";

describe("markdownToText", () => {
  it("strips headings", () => {
    expect(markdownToText("## The archive, in practice")).toBe(
      "The archive, in practice",
    );
  });

  it("keeps link text, drops the url", () => {
    expect(markdownToText("see [the spec](https://example.com)")).toBe(
      "see the spec",
    );
  });

  it("keeps image alt text", () => {
    expect(markdownToText("![a rehearsal photo](photo.jpg)")).toBe(
      "a rehearsal photo",
    );
  });

  it("keeps code content", () => {
    expect(markdownToText("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("strips emphasis", () => {
    expect(markdownToText("the **sound** design and *the show*")).toBe(
      "the sound design and the show",
    );
  });

  it("strips blockquotes and list markers", () => {
    expect(markdownToText("> a quote\n- an item\n1. numbered")).toBe(
      "a quote\nan item\nnumbered",
    );
  });

  it("collapses whitespace", () => {
    expect(markdownToText("a   b\n\n\n\nc")).toBe("a b\n\nc");
  });

  it("handles a realistic letter body", () => {
    const md = `## The archive, in practice

We discussed the **sound design** for the show. See [the notes](notes.md).

- the tempest
- tech week

> The house holds your mail until you come for it.`;
    const text = markdownToText(md);
    expect(text).toContain("sound design");
    expect(text).toContain("the tempest");
    expect(text).toContain("tech week");
    expect(text).toContain("The house holds your mail");
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toContain("(notes.md)");
  });
});
