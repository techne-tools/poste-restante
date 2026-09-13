/**
 * The record's final acts — the password confirm and the handle relabel.
 *
 * Locked here: the password change is ready only when the current key is
 * present, a new key is typed, and both tellings agree (a typo would be a
 * permanent lockout — the house never resets anyone); and the one gated
 * two-step shape asks before it acts, with a neutral escape, holding the
 * act while it is in flight.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import GatedAction from "../components/GatedAction";
import { passwordReady } from "../utils/profileUtils";

const noop = () => {};

function action(over: Partial<ComponentProps<typeof GatedAction>> = {}): string {
  return renderToStaticMarkup(
    <GatedAction
      label="Change my password"
      question="Change your password?"
      confirmLabel="Yes, change it"
      ready
      busy={false}
      confirming={false}
      onAsk={noop}
      onConfirm={noop}
      onCancel={noop}
      {...over}
    />,
  );
}

describe("passwordReady — the confirm is the act's safety", () => {
  it("requires the current key, a new key, and both tellings to agree", () => {
    expect(passwordReady("old-key", "new-key-1", "new-key-1")).toBe(true);
    expect(passwordReady("", "new-key-1", "new-key-1")).toBe(false);
    expect(passwordReady("old-key", "   ", "   ")).toBe(false);
    // The one that matters: a typo in the second telling must not be able.
    expect(passwordReady("old-key", "new-key-1", "new-key-2")).toBe(false);
  });
});

describe("GatedAction — one two-step shape", () => {
  it("rests a gated button until the act is able", () => {
    const held = action({ ready: false });
    expect(held).toContain("Change my password");
    expect(held).toMatch(/class="gated"[^>]*disabled/);

    const able = action({ ready: true });
    expect(able).not.toMatch(/class="gated"[^>]*disabled/);
  });

  it("asks before it acts, with a neutral escape", () => {
    const confirming = action({ confirming: true, question: "Change your handle to sam@house?" });
    expect(confirming).toContain("Change your handle to sam@house?");
    expect(confirming).toContain("Yes, change it");
    expect(confirming).toContain("Keep it");
    expect(confirming).not.toContain('class="gated"');
  });

  it("holds the confirm while the act is in flight", () => {
    const busy = action({ confirming: true, busy: true });
    expect(busy).toMatch(/class="clause-act"[^>]*disabled/);
  });
});
