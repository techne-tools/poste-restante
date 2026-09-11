/**
 * toLetter — the shared mapper for both protocol faces (HTTP + MCP).
 *
 * The reading surface never shows the stated-will frontmatter: a clause
 * letter's body begins with the ```clause block (role / continues), and
 * every clause thread reader (GET /v1/book/threads/:id, MCP read_clause)
 * maps the stored rows through toLetter. Stripping here means the client
 * and the MCP reader both get letters that read as letters — the support
 * act is the letter, the text is the clause (design adherence, 2026-09-11).
 */
import { describe, it, expect } from "vitest";
import { toLetter } from "../../src/schemas.js";

const baseRow = {
  id: "l_1",
  from_addr: "you@house",
  to_addrs: ["book@house"],
  cc_addrs: [] as string[],
  thread_id: "th_clause_1",
  kind: "clause",
  lang: "en-AU",
  subject: "clause: support",
  body: "",
  body_text: "",
  received_at: new Date("2026-09-11T10:00:00Z"),
  pinned_at: null,
  pinned_by: null,
  frames: [] as { frame: string; value: string }[],
};

describe("toLetter — the frontmatter stays out of the reading surface", () => {
  it("strips the clause frontmatter from a clause letter's body", () => {
    const letter = toLetter({
      ...baseRow,
      body: "```clause\nrole: support\ncontinues: th_clause_1\n```\n",
    });
    expect(letter.body.content).toBe("");
  });

  it("keeps the clause text after the frontmatter", () => {
    const letter = toLetter({
      ...baseRow,
      body: "```clause\nrole: develop\ncontinues: th_clause_1\n```\n\nthe pub stays open to the household",
    });
    expect(letter.body.content).toBe("the pub stays open to the household");
  });

  it("a plain letter's body is untouched", () => {
    const letter = toLetter({
      ...baseRow,
      kind: "letter",
      body: "just prose, no fence",
    });
    expect(letter.body.content).toBe("just prose, no fence");
  });
});
