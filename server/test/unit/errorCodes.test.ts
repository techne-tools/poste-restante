/**
 * Every error code has a matching test — or is tracked.
 *
 * The house emits machine `code` values on its JSON refusals. Each should be
 * pinned by a test so a route cannot quietly start answering a different
 * code. This scans the emitted codes and the whole server test corpus: a
 * code is either asserted somewhere, or named in the `TRACKED` ledger below
 * — the codes whose route is covered by status but whose code string is not
 * yet asserted. The ledger is a floor, not a licence: it may only shrink,
 * and a code that becomes asserted must leave it, or this test fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const srcRoot = join(root, "src");
const testRoot = join(root, "test");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const emitted = new Set<string>();
for (const file of files(srcRoot)) {
  for (const m of readFileSync(file, "utf8").matchAll(/\bcode:\s*"([^"]+)"/g)) {
    emitted.add(m[1]!);
  }
}

// The corpus excludes this guard — its own TRACKED list names the codes it
// is checking, which would make every tracked code look asserted.
let corpus = "";
for (const file of files(testRoot)) {
  if (file.endsWith("errorCodes.test.ts")) continue;
  corpus += readFileSync(file, "utf8");
}

/**
 * Codes whose route is exercised by status, but whose code string no test
 * asserts yet. Untested refusals worth pinning: the validation paths
 * (`invalid_*`), the ubiquitous machine answers (`not_found`,
 * `unauthorized`), and the two not-configurable refusals (`oidc_disabled`,
 * `out_of_reach`). Shrink this list by adding assertions.
 */
const TRACKED = new Set([
  "empty_payload",
  "invalid_card",
  "invalid_invite",
  "invalid_keys",
  "invalid_limit",
  "invalid_payload",
  "invalid_redeem",
  "invalid_renew",
  "invalid_scrub",
  "invalid_signature",
  "not_found",
  "oidc_disabled",
  "out_of_reach",
  "payload_too_large",
]);

describe("every error code has a matching test", () => {
  it("emits a plausible set (the scan is not vacuous)", () => {
    expect(emitted.size).toBeGreaterThan(20);
  });

  it("every emitted code is asserted in a test, or tracked", () => {
    const untested = [...emitted].filter((c) => !corpus.includes(c) && !TRACKED.has(c)).sort();
    expect(untested).toEqual([]);
  });

  it("no tracked code is stale — still emitted, still unasserted", () => {
    const stale = [...TRACKED].filter((c) => !emitted.has(c)).sort();
    expect(stale).toEqual([]);
  });

  it("no tracked code has since been asserted — the ledger may only shrink", () => {
    const nowTested = [...TRACKED].filter((c) => corpus.includes(c)).sort();
    expect(nowTested).toEqual([]);
  });
});
