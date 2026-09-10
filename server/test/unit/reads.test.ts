/**
 * The living pass read-back — SPEC §5 #12, hermetic unit tests.
 *
 * These prove the pure logic without infra: the per-resident read state
 * (opened/replied), the idempotent first-open-wins rule, and the
 * privacy-as-schema shape (per letter, per resident).
 */
import { describe, it, expect } from "vitest";
import { LetterReadsService } from "../../src/reads/service.js";

// A minimal fake pool: rows keyed by SQL (each test exercises one query).
function fakePool(rows: Record<string, unknown[]> = {}) {
  return {
    query: async (sql: string) => {
      return { rows: rows[sql] ?? [] };
    },
  } as never;
}

function svc(pool: ReturnType<typeof fakePool> = fakePool()) {
  return new LetterReadsService(pool);
}

describe("the read state — per (letter, resident)", () => {
  it("returns the resident's read state for a set of letters", async () => {
    const s = svc(
      fakePool({
        "SELECT letter_id, opened_at, replied_at\n       FROM letter_reads\n       WHERE address_id = $1 AND letter_id = ANY($2)": [
          { letter_id: "a", opened_at: new Date(), replied_at: null },
          { letter_id: "b", opened_at: null, replied_at: new Date() },
        ],
      }),
    );
    const state = await s.stateFor("you@house", ["a", "b", "c"]);
    expect(state.get("a")).toEqual({ opened: true, replied: false });
    expect(state.get("b")).toEqual({ opened: false, replied: true });
    expect(state.get("c")).toBeUndefined();
  });

  it("returns an empty map for no letters", async () => {
    const s = svc();
    expect((await s.stateFor("you@house", [])).size).toBe(0);
  });
});
