/**
 * The book's presentation helpers — pure, so the rules they encode earn
 * unit tests.
 *
 * The house's words are the community's (DESIGN.md, adherence rule 9): a
 * resident reads a door's name, never the database key behind it.
 */
import type { Clause } from "../api";

/** The door a clause binds, in the house's own words.
 *
 *  v1 is the pub's door (`pub@house.is_public`). The v2 family (§17) is
 *  `integrations.<id>.enabled` — a standing clause can retire a tool
 *  house-wide. An unknown door renders as itself rather than inventing a
 *  name for it. */
export function doorName(door: string): string {
  if (door === "pub@house.is_public") return "the pub's door";
  const integration = /^integrations\.(.+)\.enabled$/.exec(door);
  if (integration) return `the ${integration[1]} seam`;
  return door;
}

/** The state voice — quiet, legible, never a verdict. */
export const STATE_LABEL: Record<Clause["state"], string> = {
  proposed: "offered",
  contested: "contested — two voices",
  standing: "standing",
  reversed: "reversed",
};

/** Days until a clause can stand — the settling countdown. `now` is an
 *  injectable clock so the countdown is testable; it never goes negative. */
export function daysUntil(iso: string, now = Date.now()): number {
  const ms = new Date(iso).getTime() - now;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Only the states with a rule carry a state class: `standing`, `contested`,
 *  and `reversed` are styled; `proposed` (shown as "offered") rests in the
 *  default treatment, so it must not add a class no rule answers
 *  (adherence rule 4). */
export function clauseClass(state: Clause["state"]): string {
  return state === "proposed" ? "clause" : `clause clause-${state}`;
}
