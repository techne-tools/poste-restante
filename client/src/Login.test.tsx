/**
 * The door — its ways in, and the welcome it offers.
 *
 * Locked here: the password door, the invitation, and the keyless guest
 * door always stand; the identity-provider door appears only when the house
 * reports one (`oidcEnabled`); the primary is held until the form can act;
 * and the welcome is in the house's voice, not an empty state. The house's
 * name falls back to the founding vocabulary until the keyless meta read
 * lands (effects do not run in a static render).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ meta: {} as { oidcEnabled?: boolean } }));
vi.mock("./useHouseMeta", () => ({ useHouseMeta: () => state.meta }));

import Login from "./Login";

const noop = () => {};

function door(): string {
  return renderToStaticMarkup(<Login onAuthed={noop} onGuest={noop} />);
}

beforeEach(() => {
  state.meta = {};
});

describe("Login — the door's ways in", () => {
  it("offers the password door", () => {
    const html = door();
    expect(html).toContain("Address");
    expect(html).toContain("Password");
    expect(html).toContain("Enter the house");
  });

  it("offers the invitation", () => {
    expect(door()).toContain("Enter with your invitation");
  });

  it("offers the keyless guest door", () => {
    expect(door()).toContain("enter the pub without signing in");
  });

  it("offers the provider door only when the house has one", () => {
    state.meta = { oidcEnabled: true };
    expect(door()).toContain("Enter with your identity provider");

    state.meta = { oidcEnabled: false };
    expect(door()).not.toContain("Enter with your identity provider");
  });

  it("holds the primary until the form can act", () => {
    // With both fields empty the submit is disabled — the door is not
    // half-lit (adherence rule 5).
    expect(door()).toMatch(/type="submit"[^>]*disabled/);
  });

  it("welcomes in the door's own voice, not an empty state", () => {
    const html = door();
    expect(html).toContain('class="door-intro"');
    expect(html).not.toContain('class="empty"');
  });

  it("speaks the founding house name before the meta read lands", () => {
    expect(door()).toContain("Poste Restante");
  });
});
