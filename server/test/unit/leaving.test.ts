/**
 * Leaving as first-class — unit tests (SPEC §5.8 related).
 *
 * The state machine is mechanical: leave → out, join → in. The cache is
 * derived from the letters — the letters are the source of truth, the
 * table is the cache. Out-of-order arrival is refused by the upsert guard.
 * Visibility prunes itself: a leaver cannot see the thread's letters.
 *
 * These tests prove the derivation and the visibility limb without a
 * database — the pure functions and the SQL fragment.
 */
import { describe, it, expect } from "vitest";
import { isVisibleTo, visibleToSql } from "../../src/auth/visibility.js";

describe("isVisibleTo — the participation limb", () => {
  const letter = {
    from_addr: "you@house",
    to_addrs: ["ben@house"],
    cc_addrs: [],
    thread_id: "th_1",
  };

  it("a participant is visible by default ('in')", () => {
    expect(isVisibleTo(letter, "you@house", "in")).toBe(true);
    expect(isVisibleTo(letter, "ben@house", "in")).toBe(true);
  });

  it("a non-participant is not visible", () => {
    expect(isVisibleTo(letter, "sam@house", "in")).toBe(false);
  });

  it("a leaver ('out') is not visible even though the edges stand", () => {
    expect(isVisibleTo(letter, "you@house", "out")).toBe(false);
    expect(isVisibleTo(letter, "ben@house", "out")).toBe(false);
  });

  it("a public letter is visible to everyone, even a leaver", () => {
    const pub = {
      from_addr: "pub@house",
      to_addrs: ["you@house"],
      cc_addrs: [],
      thread_id: "th_pub",
    };
    expect(isVisibleTo(pub, "you@house", "out")).toBe(true);
    expect(isVisibleTo(pub, "sam@house", "out")).toBe(true);
  });

  it("the default participation is 'in' — the historical edges stand", () => {
    expect(isVisibleTo(letter, "you@house")).toBe(true);
  });
});

describe("visibleToSql — the participation limb", () => {
  it("includes the NOT EXISTS guard for the 'out' state", () => {
    const sql = visibleToSql(1);
    expect(sql).toContain("thread_participation");
    expect(sql).toContain("tp.state = 'out'");
    expect(sql).toContain("NOT EXISTS");
  });

  it("keeps the public exception outside the guard", () => {
    const sql = visibleToSql(1);
    // The public limb is OR'd at the top level — a public letter is
    // visible even to a leaver.
    const publicIdx = sql.indexOf("l.from_addr = 'pub@house'");
    const guardIdx = sql.indexOf("NOT EXISTS");
    expect(publicIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(publicIdx);
  });
});
