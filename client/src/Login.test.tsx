/**
 * The door — its three ways in, and the welcome it offers.
 *
 * Locked here: the password door, the identity provider, and the invitation;
 * the keyless guest door; the primary held until the form can act; and the
 * welcome in the house's voice rather than an empty state. The house's name
 * falls back to the founding vocabulary until the keyless meta read lands
 * (effects do not run in a static render).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Login from "./Login";

const noop = () => {};

function door(): string {
  return renderToStaticMarkup(<Login onAuthed={noop} onGuest={noop} />);
}

describe("Login — the door's three ways in", () => {
  it("offers the password door", () => {
    const html = door();
    expect(html).toContain("Address");
    expect(html).toContain("Password");
    expect(html).toContain("Enter the house");
  });

  it("offers the identity provider", () => {
    expect(door()).toContain("Sign in with your identity provider");
  });

  it("offers the invitation", () => {
    expect(door()).toContain("Enter with your invitation");
  });

  it("offers the keyless guest door", () => {
    expect(door()).toContain("enter the pub without signing in");
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
