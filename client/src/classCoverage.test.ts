/**
 * The class contract — both directions.
 *
 * Forward (adherence rule 4): every rendered class has a rule. The house has
 * drifted twice — the archive's `letter-row full` and the book's
 * `clause clause-proposed` were classes the CSS never answered.
 *
 * Backward: every rule is rendered. A class the stylesheet defines but no
 * surface uses is dead CSS — the other half of the same contract.
 *
 * Both are deliberately conservative. Tokens that exist only inside a
 * `${…}` interpolation are collected from the branch strings (`" active"`),
 * never from the condition (`x === "none"`); the few classes applied purely
 * from runtime data (Horizon states, clause states) are named in the
 * data-driven allowlist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Classes applied from runtime data (a state string), never a literal. */
const DATA_DRIVEN = new Set([
  "partial", // the Horizon ∩, from classifyLetter
  "dim",
  "clause-standing", // `clause-${c.state}`
  "clause-contested",
  "clause-reversed",
]);

function definedClasses(): Set<string> {
  const css = readFileSync(join(here, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) out.add(m[1]!);
  return out;
}

/** Remove `${ … }` interpolations, brace-aware, so nested templates survive. */
function stripInterpolations(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      }
      out += " ";
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Collect class tokens from a className expression — static parts plus the
 *  branch strings inside interpolations (conditions are skipped). */
function tokensFrom(expr: string): Set<string> {
  const out = new Set<string>();
  const add = (value: string) => {
    for (const t of value.split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(t)) out.add(t);
  };
  const collectQuoted = (s: string) => {
    for (const m of s.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      // A string compared with === / !== is a condition, not a class.
      const before = s.slice(0, m.index).replace(/\s+$/, "");
      if (/(===|!==|==|!=)$/.test(before)) continue;
      add(m[1] ?? m[2] ?? "");
    }
  };
  const collectTemplates = (s: string) => {
    for (const m of s.matchAll(/`([^`]*)`/g)) add(m[1]!);
  };
  const stripped = stripInterpolations(expr);
  collectTemplates(stripped);
  collectQuoted(stripped);
  collectTemplates(expr);
  collectQuoted(expr);
  return out;
}

/** Every class token a source file renders via `className`. */
function usedClasses(src: string): Set<string> {
  const out = new Set<string>();
  let i = 0;
  while ((i = src.indexOf("className", i)) !== -1) {
    let j = i + "className".length;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    if (src[j] !== "=") {
      i = j;
      continue;
    }
    j++;
    while (j < src.length && /\s/.test(src[j]!)) j++;

    if (src[j] === '"' || src[j] === "'") {
      const quote = src[j]!;
      j++;
      const end = src.indexOf(quote, j);
      for (const t of src.slice(j, end).split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(t)) out.add(t);
      i = end + 1;
      continue;
    }

    if (src[j] === "{") {
      let depth = 0;
      let k = j;
      for (; k < src.length; k++) {
        if (src[k] === "{") depth++;
        else if (src[k] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      for (const t of tokensFrom(src.slice(j + 1, k))) out.add(t);
      i = k + 1;
      continue;
    }

    i = j;
  }
  return out;
}

function sourceFiles(): string[] {
  return readdirSync(here)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test."))
    .map((f) => join(here, f));
}

function allUsedClasses(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    for (const cls of usedClasses(readFileSync(file, "utf8"))) {
      const list = used.get(cls) ?? [];
      list.push(file.slice(here.length + 1));
      used.set(cls, list);
    }
  }
  return used;
}

describe("the class contract", () => {
  it("every rendered class has a rule", () => {
    const defined = definedClasses();
    const missing = new Map<string, string[]>();
    for (const [cls, files] of allUsedClasses()) {
      if (!defined.has(cls)) missing.set(cls, files);
    }
    expect(
      [...missing.entries()].map(([cls, files]) => `${cls} (${[...new Set(files)].join(", ")})`),
    ).toEqual([]);
  });

  it("every rule is rendered", () => {
    const used = allUsedClasses();
    const dead: string[] = [];
    for (const cls of definedClasses()) {
      if (used.has(cls) || DATA_DRIVEN.has(cls)) continue;
      // Element-scoped selectors still name a class that must be rendered.
      dead.push(cls);
    }
    expect(dead.sort()).toEqual([]);
  });
});
