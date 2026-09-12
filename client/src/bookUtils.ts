/**
 * The book's presentation helpers — pure, so the rules they encode earn
 * unit tests.
 *
 * The house's words are the community's (DESIGN.md, adherence rule 9): a
 * resident reads a door's name, never the database key behind it.
 */

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
