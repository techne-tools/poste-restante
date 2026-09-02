/**
 * The clause frontmatter — the stated will of a book letter (SPEC §5.8).
 *
 * A clause letter is a letter to book@house with a small frontmatter block
 * at the top of the body. The house enforces STATED will, never inferred
 * will: every act (offer, develop, stop, support, set aside) is declared in
 * the letter, never guessed from the prose.
 *
 * The vocabulary is the household's own — consent-forward, not
 * parliamentary. A norm is *offered* (a gift the household may accept),
 * *developed* (it grows), *stopped* (a safe word — no and yes are equally
 * significant), *supported* (standing with), *set aside* (shelved, not
 * destroyed). The mechanics stay mechanical: the derivation, the settling
 * period, the bound doors. Care in the register, strength in the engine.
 *
 * Frontmatter shape (the first fenced block of the body):
 *
 *   ```clause
 *   role: offer
 *   continues: th_9f2c1        # required for develop/stop/support/set aside
 *   reverses: th_9f2c1        # optional on offer — a reversal offer
 *   binding: pub@house.is_public: true   # optional on offer/develop
 *   ```
 *
 * The rest of the body is the clause text (the norm itself). The house
 * strips the frontmatter before storing the derived text.
 */
import type { Letter } from "../types.js";

export type ClauseRole = "offer" | "develop" | "stop" | "support" | "set aside";

export interface ClauseFrontmatter {
  role: ClauseRole;
  /** The thread this act continues. Required for every role except offer. */
  continues?: string;
  /** On an offer: the thread this offer reverses when it stands. */
  reverses?: string;
  /** On an offer/develop: the door this clause binds when it stands. */
  binding?: { door: string; value: boolean };
}

const ROLE_RE = /^role:\s*(.+?)\s*$/m;
const CONTINUES_RE = /^continues:\s*(\S+)\s*$/m;
const REVERSES_RE = /^reverses:\s*(\S+)\s*$/m;
const BINDING_RE = /^binding:\s*(\S+):\s*(true|false)\s*$/m;

/** The fenced frontmatter block at the top of a clause body. */
const FRONTMATTER_RE = /^```clause\s*\n([\s\S]*?)\n```\s*\n?/;

export const CLAUSE_ROLES: ClauseRole[] = [
  "offer",
  "develop",
  "stop",
  "support",
  "set aside",
];

/** Parse the frontmatter from a clause body. Returns null when absent. */
export function parseClauseFrontmatter(body: string): ClauseFrontmatter | null {
  const m = body.match(FRONTMATTER_RE);
  if (!m) return null;
  const block = m[1]!;
  const roleMatch = block.match(ROLE_RE);
  if (!roleMatch) return null;
  const role = roleMatch[1]! as ClauseRole;
  if (!CLAUSE_ROLES.includes(role)) return null;

  const fm: ClauseFrontmatter = { role };
  const continues = block.match(CONTINUES_RE)?.[1];
  if (continues) fm.continues = continues;
  const reverses = block.match(REVERSES_RE)?.[1];
  if (reverses) fm.reverses = reverses;
  const binding = block.match(BINDING_RE);
  if (binding) fm.binding = { door: binding[1]!, value: binding[2] === "true" };
  return fm;
}

/** Strip the frontmatter block, returning the clause text (the norm). */
export function stripClauseFrontmatter(body: string): string {
  return body.replace(FRONTMATTER_RE, "").trim();
}

/** True when the letter is a clause letter addressed to the book. */
export function isClauseLetter(letter: Letter): boolean {
  return (
    letter.envelope.kind === "clause" &&
    letter.envelope.to.includes("book@house")
  );
}
