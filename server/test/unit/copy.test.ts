/**
 * The house's copy — enforced.
 *
 * The client's class contract keeps the surfaces honest; this keeps the
 * server's voice. Resident- and agent-facing copy (HTTP `message:` fields,
 * MCP `fail(...)` and `.describe(...)`) must read in the house's register:
 * calm, lowercase, no alarm words, no shouting, no internal leakage, no
 * trailing full stop. The operator CLI is held to the looser bar that fits
 * it — no shouting, no leaked internals — because its subsystem prefixes and
 * failure lines are the operator's own convention.
 *
 * Like the class contract, it is deliberately conservative: a string that
 * opens with a symbol or an interpolation is dynamic and is not judged for
 * case.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "../../src");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Acronyms / identifiers that may legitimately open a house sentence. */
const ACRONYMS = new Set(["OIDC", "IMAP", "SMTP", "MCP", "HTTP", "URL", "ID", "MinIO"]);
const ALARM = /\b(error|invalid|failed|failure|forbidden|unauthorized|exception|crash|malformed|illegal)\b/i;
const LEAK = /\[object|undefined|NaN|\bstack\b|Error:/;

interface Copy {
  file: string;
  text: string;
}

function collect(patterns: RegExp[]): Copy[] {
  const out: Copy[] = [];
  for (const file of files(srcRoot)) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(srcRoot.length + 1);
    for (const p of patterns) {
      for (const m of source.matchAll(p)) out.push({ file: rel, text: m[1]! });
    }
  }
  return out;
}

/** Resident- and agent-facing copy: HTTP messages, MCP failures and hints. */
function residentCopy(): Copy[] {
  return collect([
    /\bmessage:\s*"((?:[^"\\]|\\.){2,})"/g,
    /\bmessage:\s*`([^`\n]{2,})`/g,
    /\bfail\(\s*"((?:[^"\\]|\\.){2,})"/g,
    /\.describe\(\s*"((?:[^"\\]|\\.){2,})"/g,
  ]);
}

/** Operator output — its own bar. */
function operatorCopy(): Copy[] {
  return collect([
    /process\.(?:stdout|stderr)\.write\(\s*`([^`]{4,})`/g,
    /process\.(?:stdout|stderr)\.write\(\s*"((?:[^"\\]|\\.){4,})"/g,
  ]);
}

function firstWord(text: string): string {
  return (text.trim().split(/[\s\u2014-]+/)[0] ?? "").replace(/[^\w]/g, "");
}

function fail(copy: Copy[]): string[] {
  return copy.map((c) => `${c.file} · ${c.text}`);
}

describe("the house's copy — the resident and the agent", () => {
  const copy = residentCopy();

  it("reaches the copy (the scan is not vacuous)", () => {
    expect(copy.length).toBeGreaterThan(50);
  });

  it("never shouts", () => {
    expect(fail(copy.filter((c) => c.text.includes("!")))).toEqual([]);
  });

  it("speaks in lowercase, but for an acronym", () => {
    const bad = copy.filter((c) => {
      const first = c.text.trimStart()[0];
      if (!first || !/[A-Za-z]/.test(first)) return false; // dynamic / leading symbol
      if (first === first.toLowerCase()) return false;
      return !ACRONYMS.has(firstWord(c.text));
    });
    expect(fail(bad)).toEqual([]);
  });

  it("holds no alarm words — failures stay calm", () => {
    expect(fail(copy.filter((c) => ALARM.test(c.text)))).toEqual([]);
  });

  it("leaks no internals", () => {
    expect(fail(copy.filter((c) => LEAK.test(c.text)))).toEqual([]);
  });

  it("ends without a full stop", () => {
    expect(fail(copy.filter((c) => /\.\s*$/.test(c.text)))).toEqual([]);
  });
});

describe("the house's copy — the operator's CLI", () => {
  it("never shouts, and leaks no internals", () => {
    const bad = operatorCopy().filter((c) => c.text.includes("!") || LEAK.test(c.text));
    expect(fail(bad)).toEqual([]);
  });
});
