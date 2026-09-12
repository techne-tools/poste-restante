/**
 * The book's presentation rules — unit tests.
 *
 * The one rule worth locking: a bound door reaches a resident in the
 * house's own words, never as a raw schema key.
 */
import { describe, it, expect } from "vitest";
import { doorName } from "./bookUtils";

describe("doorName — the door a clause binds, in the house's words", () => {
  it("names the pub's door", () => {
    expect(doorName("pub@house.is_public")).toBe("the pub's door");
  });

  it("names the integration seam family (the v2 doors)", () => {
    expect(doorName("integrations.web-search.enabled")).toBe("the web-search seam");
    expect(doorName("integrations.transcriber.enabled")).toBe("the transcriber seam");
  });

  it("leaves an unknown door as itself rather than inventing a name", () => {
    expect(doorName("future@house.flag")).toBe("future@house.flag");
  });
});
