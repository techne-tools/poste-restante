/**
 * One line of the address book — its states (SPEC §15).
 *
 * v1 refuses to seal to an address with no keys, which is correct: a sealed
 * letter must not silently exclude an addressee. What was wrong is that the
 * state was invisible until a send threw. The row says it, in the house's
 * quiet voice, and the row still opens a letter — unsealed correspondence is
 * fine.
 *
 * Two further states ride here, and they are the keyletter's:
 *
 *   no keys yet   the row OFFERS the in-band remedy (send my keys), because a
 *                 correspondent with an address and no keys has no other way
 *                 to be told in the house's idiom.
 *   a key change  a keyletter whose keys differ from the live record does not
 *                 overwrite it. The offer is visible, and answering it is the
 *                 resident's act — never a silent update.
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

  it("offers to send my keys to a keyless correspondent", () => {
    const html = renderToStaticMarkup(
      <AddressRow
        address={address({ ageRecipient: null, ed25519Public: null })}
        onCompose={noop}
        from="chris@house"
        onSendKeys={noop}
      />,
    );
    expect(html).toContain("send my keys");
  });

  it("does not offer to send my keys to myself, or to an instrument, or without a session", () => {
    const self = renderToStaticMarkup(
      <AddressRow address={address({ id: "chris@house", ageRecipient: null })} onCompose={noop} from="chris@house" onSendKeys={noop} />,
    );
    const agent = renderToStaticMarkup(
      <AddressRow address={address({ isAgent: true, ageRecipient: null })} onCompose={noop} from="chris@house" onSendKeys={noop} />,
    );
    const noSession = renderToStaticMarkup(
      <AddressRow address={address({ ageRecipient: null })} onCompose={noop} />,
    );
    for (const html of [self, agent, noSession]) expect(html).not.toContain("send my keys");
  });

  it("shows a key change waiting on a human, with both answers", () => {
    const html = renderToStaticMarkup(
      <AddressRow
        address={address({
          keyOffer: {
            letterId: "letter-1",
            ageRecipient: "age1new",
            ed25519Public: "ed-new",
            recoveryAgeRecipient: null,
            createdAt: "2026-11-08T12:00:00.000Z",
          },
        })}
        onCompose={noop}
        from="chris@house"
        onAnswerOffer={noop}
      />,
    );

    // The change is visible, and it says plainly that the record has NOT moved.
    expect(html).toContain("has published different keys");
    expect(html).toContain("The house has not changed the record");
    expect(html).toContain("Accept the new key");
    expect(html).toContain("Leave the record as it is");
  });

  it("says nothing about a key change when there is none", () => {
    const html = renderToStaticMarkup(
      <AddressRow address={address()} onCompose={noop} from="chris@house" onAnswerOffer={noop} />,
    );
    expect(html).not.toContain("has published different keys");
  });
});
