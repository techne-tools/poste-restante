/**
 * Agents — instruments, not servants (SPEC §16), hermetic unit tests.
 *
 * These prove the pure logic without infra: the birth-letter parsing
 * (the will), and the reach enumeration (the three doors).
 */
import { describe, it, expect } from "vitest";
import { AgentService } from "../../src/agents/service.js";

// A minimal fake pool: rows keyed by SQL (each test exercises one query).
function fakePool(rows: Record<string, unknown[]> = {}) {
  return {
    query: async (sql: string) => {
      return { rows: rows[sql] ?? [] };
    },
  } as never;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;
const noopRepo = {} as never;
const noopPipeline = {} as never;

function svc(pool: ReturnType<typeof fakePool> = fakePool()) {
  return new AgentService(pool, noopRepo, noopPipeline, noopLog);
}

describe("birth letter parsing — the will", () => {
  it("parses the task from the first line", () => {
    const s = svc();
    const birth = s.parseBirth("track calls for international arts grants");
    expect(birth.task).toBe("track calls for international arts grants");
  });

  it("parses the optional reach lines", () => {
    const s = svc();
    const birth = s.parseBirth(
      [
        "track calls for international arts grants",
        "lifespan: production:grant-season-2026",
        "group: th_grants",
        "pub: true",
        "beneficiary: you@house",
      ].join("\n"),
    );
    expect(birth.lifespan).toBe("production:grant-season-2026");
    expect(birth.group).toBe("th_grants");
    expect(birth.pub).toBe(true);
    expect(birth.beneficiary).toBe("you@house");
  });

  it("defaults the pub grant to closed", () => {
    const s = svc();
    const birth = s.parseBirth("watch ticket sales for a gig");
    expect(birth.pub).toBeUndefined();
  });
});

describe("the reach — enumerated, not discoverable", () => {
  const doorsRow = {
    creator: "you@house",
    group_thread: "th_grants",
    pub_grant: true,
  };

  it("the creator is always a door", async () => {
    const s = svc(
      fakePool({
        "SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL": [
          doorsRow,
        ],
      }),
    );
    expect(await s.canAddress("grantwatch@house", "you@house")).toBe(true);
  });

  it("the opt-in group is a door", async () => {
    const s = svc(
      fakePool({
        "SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL": [
          doorsRow,
        ],
      }),
    );
    expect(await s.canAddress("grantwatch@house", "th_grants")).toBe(true);
  });

  it("the pub is a door only when granted", async () => {
    const s = svc(
      fakePool({
        "SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL": [
          doorsRow,
        ],
      }),
    );
    expect(await s.canAddress("grantwatch@house", "pub@house")).toBe(true);

    const closed = svc(
      fakePool({
        "SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL": [
          { ...doorsRow, pub_grant: false },
        ],
      }),
    );
    expect(await closed.canAddress("grantwatch@house", "pub@house")).toBe(false);
  });

  it("a stranger is not a door — no cold reads", async () => {
    const s = svc(
      fakePool({
        "SELECT creator, group_thread, pub_grant FROM agents WHERE address = $1 AND died_at IS NULL": [
          doorsRow,
        ],
      }),
    );
    expect(await s.canAddress("grantwatch@house", "ben@house")).toBe(false);
  });

  it("a dead agent has no doors", async () => {
    const s = svc(fakePool()); // no row — died or never born
    expect(await s.canAddress("ghost@house", "you@house")).toBe(false);
  });
});

describe("the death sweep — tasks die", () => {
  const expiredRow = {
    address: "grantwatch@house",
    creator: "you@house",
    task: "track calls for international arts grants",
    lifespan_frame: "production:grant-season-2026",
  };

  it("kills nothing when the final letter fails — the next sweep retries", async () => {
    let ingestCalls = 0;
    let killed = false;
    const killingPool = {
      query: async (sql: string) => {
        if (sql.includes("FROM agents a")) return { rows: [expiredRow] };
        if (sql.includes("UPDATE agents SET died_at")) {
          killed = true;
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
    };
    const failingPipeline = {
      ingest: async () => {
        ingestCalls += 1;
        throw new Error("semantic layer unreachable");
      },
    };
    const s = new AgentService(
      killingPool as never,
      noopRepo,
      failingPipeline as never,
      noopLog,
    );
    const killedList = await s.sweepExpired(new Date("2026-09-12T00:00:00Z"), 30 * 24 * 60 * 60 * 1000);
    expect(killedList).toEqual([]);
    expect(ingestCalls).toBe(1);
    expect(killed).toBe(false); // no final letter → no kill → the next sweep retries
  });

  it("writes the final letter then kills — the full death", async () => {
    const letters: {
      envelope: { from: string; to: string[] };
      body: { content: string };
    }[] = [];
    let killed = false;
    const killingPool = {
      query: async (sql: string) => {
        if (sql.includes("FROM agents a")) return { rows: [expiredRow] };
        if (sql.includes("UPDATE agents SET died_at")) {
          killed = true;
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
    };
    const pipeline = {
      ingest: async (letter: unknown) => {
        letters.push(letter as {
          envelope: { from: string; to: string[] };
          body: { content: string };
        });
        return { letterId: "final-1", created: true };
      },
    };
    const s = new AgentService(
      killingPool as never,
      noopRepo,
      pipeline as never,
      noopLog,
    );
    const killedList = await s.sweepExpired(new Date("2026-09-12T00:00:00Z"), 30 * 24 * 60 * 60 * 1000);
    expect(killedList).toEqual(["grantwatch@house"]);
    expect(killed).toBe(true);
    // The final letter is the instrument's own closing word, to its
    // creator only, carrying the task and the sign-off.
    expect(letters).toHaveLength(1);
    expect(letters[0].envelope.from).toBe("grantwatch@house");
    expect(letters[0].envelope.to).toEqual(["you@house"]);
    expect(letters[0].body.content).toContain("track calls for international arts grants");
    expect(letters[0].body.content).toContain("my frame closed — this task is done.");
  });
});
