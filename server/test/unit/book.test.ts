/**
 * House book unit tests — the pure derivation (SPEC §5.8).
 *
 * The state machine is mechanical: proposal opens, amendment rewrites,
 * objection contests, vouch orders, withdraw clears. Settling is slow by
 * construction. Reversal is a role, not a deletion. These tests prove the
 * derivation without a database — the thread is the source of truth, the
 * table is the cache.
 */
import { describe, it, expect } from "vitest";
import { deriveClause } from "../../src/book/service.js";
import { parseClauseFrontmatter, stripClauseFrontmatter } from "../../src/book/frontmatter.js";
import type { Letter } from "../../src/types.js";

const T0 = new Date("2026-09-01T00:00:00Z");
const DAY = 86_400_000;

/** Build a clause letter. `at` is the gregorian time; `body` is the full
 *  body (frontmatter + text). */
function clause(
  from: string,
  at: Date,
  body: string,
  thread = "th_clause_test",
  id = `l_${from}_${at.getTime()}`,
): Letter {
  return {
    id,
    envelope: {
      from,
      to: ["book@house"],
      cc: [],
      thread,
      kind: "clause",
      lang: "en-AU",
      subject: "clause",
    },
    time: { gregorian: at.toISOString(), frames: [] },
    body: { format: "markdown", content: body },
  };
}

const proposal = (text: string, extra = "") =>
  `\`\`\`clause\nrole: proposal\n${extra}\`\`\`\n\n${text}`;

const amendment = (text: string, extra = "") =>
  `\`\`\`clause\nrole: amendment\namends: th_clause_test\n${extra}\`\`\`\n\n${text}`;

const objection = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: objection\namends: " + thread + "\n```\n\nI object.", thread);

const vouch = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: vouch\namends: " + thread + "\n```\n\nI vouch.", thread);

const withdraw = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: withdraw\namends: " + thread + "\n```\n\nI withdraw my objection.", thread);

describe("parseClauseFrontmatter", () => {
  it("parses a proposal with binding and reverses", () => {
    const fm = parseClauseFrontmatter(
      "```clause\nrole: proposal\nreverses: th_old\nbinding: pub@house.is_public: false\n```\n\nthe pub closes at dusk",
    );
    expect(fm).toEqual({
      role: "proposal",
      reverses: "th_old",
      binding: { door: "pub@house.is_public", value: false },
    });
  });

  it("parses an amendment with amends", () => {
    const fm = parseClauseFrontmatter(
      "```clause\nrole: amendment\namends: th_clause_test\n```\n\nnew text",
    );
    expect(fm).toEqual({ role: "amendment", amends: "th_clause_test" });
  });

  it("returns null for a body without frontmatter", () => {
    expect(parseClauseFrontmatter("just prose")).toBeNull();
  });

  it("returns null for an unknown role", () => {
    expect(parseClauseFrontmatter("```clause\nrole: decree\n```\n\nno")).toBeNull();
  });
});

describe("stripClauseFrontmatter", () => {
  it("removes the frontmatter block, keeping the text", () => {
    expect(
      stripClauseFrontmatter("```clause\nrole: proposal\n```\n\nthe pub closes at dusk"),
    ).toBe("the pub closes at dusk");
  });
});

describe("deriveClause — proposal and settling", () => {
  it("a fresh proposal is proposed, settling in the future", () => {
    const d = deriveClause([clause("you@house", T0, proposal("the pub closes at dusk"))], T0, 7);
    expect(d).not.toBeNull();
    expect(d!.state).toBe("proposed");
    expect(d!.text).toBe("the pub closes at dusk");
    expect(d!.proposedBy).toBe("you@house");
    expect(d!.objections).toBe(0);
    expect(d!.vouches).toBe(0);
    expect(d!.settlesAt.getTime()).toBe(T0.getTime() + 7 * DAY);
  });

  it("a proposal stands after the settling period with no objection", () => {
    const after = new Date(T0.getTime() + 8 * DAY);
    const d = deriveClause([clause("you@house", T0, proposal("the pub closes at dusk"))], after, 7);
    expect(d!.state).toBe("standing");
    expect(d!.stoodAt!.getTime()).toBe(T0.getTime() + 7 * DAY);
  });

  it("an objection contests a proposed clause — it never stands", () => {
    const after = new Date(T0.getTime() + 8 * DAY);
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      objection("ben@house", new Date(T0.getTime() + DAY)),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.state).toBe("contested");
    expect(d!.objections).toBe(1);
    expect(d!.stoodAt).toBeNull();
  });

  it("withdrawing the last objection restarts the settling clock", () => {
    const objAt = new Date(T0.getTime() + DAY);
    const wdAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 3 * DAY); // before the original settle
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      objection("ben@house", objAt),
      withdraw("ben@house", wdAt),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.state).toBe("proposed");
    expect(d!.objections).toBe(0);
    // Fresh settlement from the withdraw, not the proposal.
    expect(d!.settlesAt.getTime()).toBe(wdAt.getTime() + 7 * DAY);
  });

  it("a second objection from the same resident is one objection", () => {
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      objection("ben@house", new Date(T0.getTime() + DAY)),
      objection("ben@house", new Date(T0.getTime() + 2 * DAY)),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.objections).toBe(1);
    expect(d!.state).toBe("contested");
  });

  it("vouches are distinct per resident and order, never command", () => {
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      vouch("ben@house", new Date(T0.getTime() + DAY)),
      vouch("ben@house", new Date(T0.getTime() + 2 * DAY)),
      vouch("sam@house", new Date(T0.getTime() + 3 * DAY)),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.vouches).toBe(2);
    expect(d!.state).toBe("standing"); // vouches never block settling
  });
});

describe("deriveClause — amendment", () => {
  it("an amendment replaces the text, clears objections, keeps vouches, restarts settling", () => {
    const amendAt = new Date(T0.getTime() + 2 * DAY);
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      objection("ben@house", new Date(T0.getTime() + DAY)),
      vouch("sam@house", new Date(T0.getTime() + DAY)),
      clause("you@house", amendAt, amendment("the pub closes at midnight")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 3 * DAY), 7);
    expect(d!.text).toBe("the pub closes at midnight");
    expect(d!.objections).toBe(0); // the objection was to the old text
    expect(d!.vouches).toBe(1); // the vouch is to the norm's direction
    expect(d!.state).toBe("proposed");
    expect(d!.settlesAt.getTime()).toBe(amendAt.getTime() + 7 * DAY);
  });

  it("an amendment can change the binding", () => {
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk", "binding: pub@house.is_public: false\n")),
      clause("you@house", new Date(T0.getTime() + DAY), amendment("the pub stays open", "binding: pub@house.is_public: true\n")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.binding).toEqual({ door: "pub@house.is_public", value: true });
    expect(d!.state).toBe("standing");
  });
});

describe("deriveClause — reversal", () => {
  it("a reversal proposal that stands becomes a standing norm, marked as a reversal", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 10 * DAY);
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      clause("ben@house", revAt, proposal("the pub stays open", "reverses: th_clause_test\n")),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.pendingReversal).toBe(true);
    expect(d!.reversesThread).toBe("th_clause_test");
    // The reversal itself stands — "the pub stays open" is the current
    // norm. The TARGET's reversal is derived cross-thread in deriveAll,
    // never declared here.
    expect(d!.state).toBe("standing");
    expect(d!.stoodAt!.getTime()).toBe(revAt.getTime() + 7 * DAY);
  });

  it("a reversal proposal is still proposed before settling", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      clause("ben@house", revAt, proposal("the pub stays open", "reverses: th_clause_test\n")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 3 * DAY), 7);
    expect(d!.state).toBe("proposed");
    expect(d!.pendingReversal).toBe(true);
  });

  it("an objection to a reversal proposal keeps the original standing", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 10 * DAY);
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      clause("ben@house", revAt, proposal("the pub stays open", "reverses: th_clause_test\n")),
      objection("sam@house", new Date(T0.getTime() + 3 * DAY)),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.state).toBe("contested");
    expect(d!.reversedAt).toBeNull();
  });
});

describe("deriveClause — edge cases", () => {
  it("returns null for an empty thread", () => {
    expect(deriveClause([], T0, 7)).toBeNull();
  });

  it("returns null when no proposal ever opened the thread", () => {
    const letters = [objection("ben@house", T0)];
    expect(deriveClause(letters, T0, 7)).toBeNull();
  });

  it("a letter without frontmatter in the thread is prose, not an act", () => {
    const letters = [
      clause("you@house", T0, proposal("the pub closes at dusk")),
      clause("ben@house", new Date(T0.getTime() + DAY), "I think this is a good idea."),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.state).toBe("standing");
    expect(d!.objections).toBe(0);
  });
});
