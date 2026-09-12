/**
 * Every rendered class has a rule — adherence rule 4, enforced.
 *
 * The house has drifted twice on this: the archive's `letter-row full` and
 * the book's `clause clause-proposed` were classes the CSS never answered.
 * This test scans every className in the client (literals and the static
 * parts of templates) and asserts each token resolves to a rule in
 * styles.css, so the drift cannot return unnoticed.
 *
 * It is deliberately conservative: tokens that only exist inside a `${…}`
 * interpolation (runtime data) are not collected — those are covered by the
 * component tests and by an explicit rule (or the absence of the class).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Every class the stylesheet defines. */
function definedClasses(): Set<string> {
  const css = readFileSync(join(here, "styles.css"), "utf8");
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

/** Every class token a source file renders via `className`. */
function usedClasses(src: string): Set<string> {
  const out = new Set<string>();
  const add = (value: string) => {
    for (const t of value.split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(t)) out.add(t);
  };
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
      add(src.slice(j, end));
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
      const stripped = stripInterpolations(src.slice(j + 1, k));
      for (const m of stripped.matchAll(/`([^`]*)`/g)) add(m[1]!);
      for (const m of stripped.matchAll(/"([^"]*)"|'([^']*)'/g)) {
        // A string compared with === / !== is a condition, not a class.
        const before = stripped.slice(0, m.index).replace(/\s+$/, "");
        if (/(===|!==|==|!=)$/.test(before)) continue;
        add(m[1] ?? m[2] ?? "");
      }
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

describe("every rendered class has a rule", () => {
  it("resolves every className in the client's source to styles.css", () => {
    const defined = definedClasses();
    const missing = new Map<string, string[]>();
    for (const file of sourceFiles()) {
      const used = usedClasses(readFileSync(file, "utf8"));
      for (const cls of used) {
        if (!defined.has(cls)) {
          const list = missing.get(cls) ?? [];
          list.push(file.slice(here.length + 1));
          missing.set(cls, list);
        }
      }
    }
    expect(
      [...missing.entries()].map(([cls, files]) => `${cls} (${[...new Set(files)].join(", ")})`),
    ).toEqual([]);
  });
});
