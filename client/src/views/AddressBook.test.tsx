/**
 * One line of the address book — its two states (item 6, client half).
 *
 * v1 refuses to seal to an address with no keys, which is correct: a sealed
 * letter must not silently exclude an addressee. What was wrong is that the
 * state was invisible until a send threw. The row says it, in the house's
 * quiet voice, and the row still opens a letter — unsealed correspondence
 * is fine.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressRow } from "./AddressBook";
import type { Address } from "../api";

const noop = () => {};

function address(overrides: Partial<Address> = {}): Address {
  return {
    id: "sam@house",
    names: [],
    pronouns: null,
    ageRecipient: "age1recipient",
    ed25519Public: "ed25519",
    recoveryAgeRecipient: null,
    isAgent: false,
    sealDefault: false,
    ...overrides,
  } as Address;
}

describe("the address book row", () => {
  it("marks an address with no keys, and still offers the row", () => {
    const html = renderToStaticMarkup(
      <AddressRow
        address={address({ ageRecipient: null, ed25519Public: null })}
        onCompose={noop}
      />,
    );

    expect(html).toContain("no keys yet");
    expect(html).toContain("a sealed letter cannot reach them");
    // Still a letter's door: the refusal is about sealing, not writing.
    expect(html).toContain("sam@house");
  });

  it("says nothing about keys for an address that has them", () => {
    const html = renderToStaticMarkup(<AddressRow address={address()} onCompose={noop} />);

    expect(html).not.toContain("no keys yet");
    expect(html).toContain("Write to sam@house");
  });
});
