/**
 * The machine's vocabulary — one dialect.
 *
 * Distinct from the copy guard, which holds the house's *words*. This holds
 * the machine's words: every JSON error `code` is lowercase snake_case,
 * every log event is `namespace:event` with kebab-case segments, and every
 * whisper kind is kebab-case. Locked so a new code or event cannot quietly
 * drift into another dialect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "../../src");

const CODE = /^[a-z][a-z0-9_]*$/;
const EVENT = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/;
const KIND = /^[a-z][a-z0-9-]*$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function scan(re: RegExp): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = [];
  for (const file of files(srcRoot)) {
    const rel = file.slice(srcRoot.length + 1);
    for (const m of readFileSync(file, "utf8").matchAll(re)) out.push({ file: rel, value: m[1]! });
  }
  return out;
}

describe("the machine's vocabulary", () => {
  const codes = scan(/\bcode:\s*"([^"]+)"/g);
  const events = scan(/\.(?:info|warn|error)\(\s*"([^"]+)"/g);

  it("reaches the vocabulary (the scan is not vacuous)", () => {
    expect(codes.length).toBeGreaterThan(20);
    expect(events.length).toBeGreaterThan(50);
  });

  it("error codes are lowercase snake_case", () => {
    const bad = codes.filter((c) => !CODE.test(c.value));
    expect(bad.map((c) => `${c.file} · ${c.value}`)).toEqual([]);
  });

  it("log events are namespace:event, kebab-case", () => {
    const bad = events.filter((e) => !EVENT.test(e.value));
    expect(bad.map((e) => `${e.file} · ${e.value}`)).toEqual([]);
  });

  it("whisper kinds are kebab-case", () => {
    const source = readFileSync(join(srcRoot, "whisper/service.ts"), "utf8");
    const start = source.indexOf("export type WhisperKind");
    const block = source.slice(start, source.indexOf(";", start));
    const kinds = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(4);
    expect(kinds.filter((k) => !KIND.test(k))).toEqual([]);
  });
});
