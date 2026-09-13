/**
 * The house's copy — the client's side.
 *
 * The server's copy has its own guard; this keeps the client's door and
 * room messages in the same register. Only the house's *messages* are
 * judged — the strings passed to `setError`, the fallbacks beside
 * `err.message`, and the client's own thrown errors — never the UI's labels
 * and headings, which legitimately open with a capital. Rules: calm (no
 * shouting), lowercase but for an acronym, no alarm words, no leaked
 * internals, no trailing full stop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const ACRONYMS = new Set(["OIDC", "IMAP", "SMTP", "MCP", "HTTP", "URL", "ID"]);
const ALARM = /\b(error|invalid|failed|failure|forbidden|unauthorized|exception|crash|malformed|illegal)\b/i;
const LEAK = /\[object|undefined|NaN|\bstack\b|Error:/;

interface Copy {
  file: string;
  text: string;
}

function collect(): Copy[] {
  const out: Copy[] = [];
  const dirs = ["api", "components", "hooks", "utils", "views"];
  const scan = (dir: string) => {
    const files = readdirSync(dir).filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test."),
    );
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8");
      const push = (m: RegExpMatchArray) => out.push({ file: `${dir.replace(here + "/", "")}/${name}`, text: m[1]! });
      for (const m of source.matchAll(/\bsetError\(\s*"((?:[^"\\]|\\.){3,})"/g)) push(m);
      for (const m of source.matchAll(/err\.message\s*:\s*"((?:[^"\\]|\\.){3,})"/g)) push(m);
      for (const m of source.matchAll(/throw new Error\(\s*"((?:[^"\\]|\\.){3,})"/g)) push(m);
    }
  };
  scan(here);
  for (const dir of dirs) scan(join(here, dir));
  return out;
}

function firstWord(text: string): string {
  return (text.trim().split(/[\s\u2014-]+/)[0] ?? "").replace(/[^\w]/g, "");
}

function fail(copy: Copy[]): string[] {
  return copy.map((c) => `${c.file} · ${c.text}`);
}

describe("the house's copy — the client", () => {
  const copy = collect();

  it("reaches the copy (the scan is not vacuous)", () => {
    expect(copy.length).toBeGreaterThan(20);
  });

  it("never shouts", () => {
    expect(fail(copy.filter((c) => c.text.includes("!")))).toEqual([]);
  });

  it("speaks in lowercase, but for an acronym", () => {
    const bad = copy.filter((c) => {
      const first = c.text.trimStart()[0];
      if (!first || !/[A-Za-z]/.test(first)) return false;
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
