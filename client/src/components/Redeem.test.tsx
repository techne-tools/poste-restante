/**
 * The invitation — its states and its way back.
 *
 * Locked here: the invitation mounts a keyless door (not the two-column
 * house), asks for the letter's three fields, keeps the primary held until
 * the form can act, and offers a way back to the door. The house's name
 * falls back to the founding vocabulary until the keyless meta read lands
 * (effects do not run in a static render).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Redeem from "./Redeem";

const noop = () => {};

function invite(): string {
  return renderToStaticMarkup(<Redeem onAuthed={noop} onBack={noop} />);
}

describe("Redeem — the invitation", () => {
  it("mounts the door layout, not the two-column house", () => {
    // The keyless door has no whisper sidebar; `.house` would strand the
    // card in the 300px column.
    expect(invite()).toContain('class="house door"');
  });

  it("asks for the letter, the code, and the password you keep", () => {
    const html = invite();
    expect(html).toContain("Address");
    expect(html).toContain("Invitation code");
    expect(html).toContain("New password");
    expect(html).toContain("Accept the invitation");
  });

  it("welcomes in the door's voice, not an empty state", () => {
    const html = invite();
    expect(html).toContain('class="door-intro"');
    expect(html).not.toContain('class="empty"');
  });

  it("offers the way back to the door", () => {
    expect(invite()).toContain("Back to the door");
  });

  it("holds the primary until the form can act", () => {
    expect(invite()).toMatch(/type="submit"[^>]*disabled/);
  });

  it("speaks the founding house name before the meta read lands", () => {
    expect(invite()).toContain("Poste Restante");
  });
});
