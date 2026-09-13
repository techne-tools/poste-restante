/**
 * App's OIDC return — what the door does with the fragment.
 *
 * App's mount effect reads the URL fragment and applies a plan: sign in,
 * show the door's error, or ignore. The plan is pure, so it is tested here
 * without a browser (the repo renders with react-dom/server; no jsdom).
 */
import { describe, it, expect } from "vitest";
import { planOidcReturn, readOidcReturn } from "./utils/oidcReturn";

describe("App — the OIDC return it applies", () => {
  it("signs in from a success fragment — a Bearer credential", () => {
    const plan = planOidcReturn(readOidcReturn("#oidc=pr_tok&address=you%40house"));
    expect(plan).toEqual({ action: "signin", address: "you@house", header: "Bearer pr_tok" });
  });

  it("shows the door's error from a failure fragment", () => {
    const plan = planOidcReturn(readOidcReturn("#oidc_error=this%20attempt%20expired"));
    expect(plan).toEqual({ action: "error", message: "this attempt expired" });
  });

  it("does nothing without a complete outcome", () => {
    expect(planOidcReturn(null)).toEqual({ action: "none" });
    expect(planOidcReturn({ token: "pr_tok" })).toEqual({ action: "none" }); // no address
    expect(planOidcReturn({ address: "you@house" })).toEqual({ action: "none" }); // no token
  });
});
