/**
 * House book unit tests — the pure derivation (SPEC §5.8).
 *
 * The state machine is mechanical, and the vocabulary is the household's
 * own — consent-forward, not parliamentary: offer opens, develop rewrites,
 * stop contests (a safe word — no and yes are equally significant),
 * support orders, set aside clears. Settling is slow by construction.
 * Reversal is a role, not a deletion. These tests prove the derivation
 * without a database — the thread is the source of truth, the table is
 * the cache.
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

const offer = (text: string, extra = "") =>
  `\`\`\`clause\nrole: offer\n${extra}\`\`\`\n\n${text}`;

const develop = (text: string, extra = "") =>
  `\`\`\`clause\nrole: develop\ncontinues: th_clause_test\n${extra}\`\`\`\n\n${text}`;

const stop = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: stop\ncontinues: " + thread + "\n```\n\nI don't want this to happen any more.", thread);

const support = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: support\ncontinues: " + thread + "\n```\n\nI stand with this.", thread);

const setAside = (from: string, at: Date, thread = "th_clause_test") =>
  clause(from, at, "```clause\nrole: set aside\ncontinues: " + thread + "\n```\n\nI set my stop aside.", thread);

describe("parseClauseFrontmatter", () => {
  it("parses an offer with binding and reverses", () => {
    const fm = parseClauseFrontmatter(
      "```clause\nrole: offer\nreverses: th_old\nbinding: pub@house.is_public: false\n```\n\nthe pub closes at dusk",
    );
    expect(fm).toEqual({
      role: "offer",
      reverses: "th_old",
      binding: { door: "pub@house.is_public", value: false },
    });
  });

  it("parses a develop with continues", () => {
    const fm = parseClauseFrontmatter(
      "```clause\nrole: develop\ncontinues: th_clause_test\n```\n\nnew text",
    );
    expect(fm).toEqual({ role: "develop", continues: "th_clause_test" });
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
      stripClauseFrontmatter("```clause\nrole: offer\n```\n\nthe pub closes at dusk"),
    ).toBe("the pub closes at dusk");
  });
});

describe("deriveClause — offer and settling", () => {
  it("a fresh offer is offered, settling in the future", () => {
    const d = deriveClause([clause("you@house", T0, offer("the pub closes at dusk"))], T0, 7);
    expect(d).not.toBeNull();
    expect(d!.state).toBe("proposed");
    expect(d!.text).toBe("the pub closes at dusk");
    expect(d!.proposedBy).toBe("you@house");
    expect(d!.objections).toBe(0);
    expect(d!.vouches).toBe(0);
    expect(d!.settlesAt.getTime()).toBe(T0.getTime() + 7 * DAY);
  });

  it("an offer stands after the settling period with no stop", () => {
    const after = new Date(T0.getTime() + 8 * DAY);
    const d = deriveClause([clause("you@house", T0, offer("the pub closes at dusk"))], after, 7);
    expect(d!.state).toBe("standing");
    expect(d!.stoodAt!.getTime()).toBe(T0.getTime() + 7 * DAY);
  });

  it("a stop contests an offered clause — it never stands", () => {
    const after = new Date(T0.getTime() + 8 * DAY);
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      stop("ben@house", new Date(T0.getTime() + DAY)),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.state).toBe("contested");
    expect(d!.objections).toBe(1);
    expect(d!.stoodAt).toBeNull();
  });

  it("setting aside the last stop restarts the settling clock", () => {
    const objAt = new Date(T0.getTime() + DAY);
    const wdAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 3 * DAY); // before the original settle
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      stop("ben@house", objAt),
      setAside("ben@house", wdAt),
    ];
    const d = deriveClause(letters, after, 7);
    expect(d!.state).toBe("proposed");
    expect(d!.objections).toBe(0);
    // Fresh settlement from the set aside, not the offer.
    expect(d!.settlesAt.getTime()).toBe(wdAt.getTime() + 7 * DAY);
  });

  it("a second stop from the same resident is one stop", () => {
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      stop("ben@house", new Date(T0.getTime() + DAY)),
      stop("ben@house", new Date(T0.getTime() + 2 * DAY)),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.objections).toBe(1);
    expect(d!.state).toBe("contested");
  });

  it("supports are distinct per resident and order, never command", () => {
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      support("ben@house", new Date(T0.getTime() + DAY)),
      support("ben@house", new Date(T0.getTime() + 2 * DAY)),
      support("sam@house", new Date(T0.getTime() + 3 * DAY)),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.vouches).toBe(2);
    expect(d!.state).toBe("standing"); // supports never block settling
  });
});

describe("deriveClause — develop", () => {
  it("a develop replaces the text, clears stops, keeps supports, restarts settling", () => {
    const amendAt = new Date(T0.getTime() + 2 * DAY);
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      stop("ben@house", new Date(T0.getTime() + DAY)),
      support("sam@house", new Date(T0.getTime() + DAY)),
      clause("you@house", amendAt, develop("the pub closes at midnight")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 3 * DAY), 7);
    expect(d!.text).toBe("the pub closes at midnight");
    expect(d!.objections).toBe(0); // the stop was to the old text
    expect(d!.vouches).toBe(1); // the support is to the norm's direction
    expect(d!.state).toBe("proposed");
    expect(d!.settlesAt.getTime()).toBe(amendAt.getTime() + 7 * DAY);
  });

  it("a develop can change the binding", () => {
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk", "binding: pub@house.is_public: false\n")),
      clause("you@house", new Date(T0.getTime() + DAY), develop("the pub stays open", "binding: pub@house.is_public: true\n")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.binding).toEqual({ door: "pub@house.is_public", value: true });
    expect(d!.state).toBe("standing");
  });
});

describe("deriveClause — reversal", () => {
  it("a reversal offer that stands becomes a standing norm, marked as a reversal", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 10 * DAY);
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      clause("ben@house", revAt, offer("the pub stays open", "reverses: th_clause_test\n")),
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

  it("a reversal offer is still offered before settling", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      clause("ben@house", revAt, offer("the pub stays open", "reverses: th_clause_test\n")),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 3 * DAY), 7);
    expect(d!.state).toBe("proposed");
    expect(d!.pendingReversal).toBe(true);
  });

  it("a stop to a reversal offer keeps the original standing", () => {
    const revAt = new Date(T0.getTime() + 2 * DAY);
    const after = new Date(T0.getTime() + 10 * DAY);
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      clause("ben@house", revAt, offer("the pub stays open", "reverses: th_clause_test\n")),
      stop("sam@house", new Date(T0.getTime() + 3 * DAY)),
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

  it("returns null when no offer ever opened the thread", () => {
    const letters = [stop("ben@house", T0)];
    expect(deriveClause(letters, T0, 7)).toBeNull();
  });

  it("a letter without frontmatter in the thread is prose, not an act", () => {
    const letters = [
      clause("you@house", T0, offer("the pub closes at dusk")),
      clause("ben@house", new Date(T0.getTime() + DAY), "I think this is a good idea."),
    ];
    const d = deriveClause(letters, new Date(T0.getTime() + 8 * DAY), 7);
    expect(d!.state).toBe("standing");
    expect(d!.objections).toBe(0);
  });
});
