/**
 * The OIDC door's return fragment — the client half of the callback contract.
 *
 * The server hands the browser back with the outcome in the URL fragment;
 * this is the parse the door trusts. Locked here so the two halves cannot
 * drift: success carries a bearer token and the address, failure carries a
 * message, and anything else is silence.
 */
import { describe, it, expect } from "vitest";
import { readOidcReturn } from "./oidcReturn";

describe("readOidcReturn — the door's return fragment", () => {
  it("reads nothing from an empty or unrelated fragment", () => {
    expect(readOidcReturn("")).toBeNull();
    expect(readOidcReturn("#")).toBeNull();
    expect(readOidcReturn("#something=else")).toBeNull();
  });

  it("reads the success token and address", () => {
    expect(readOidcReturn("#oidc=pr_tok&address=you%40house")).toEqual({
      token: "pr_tok",
      address: "you@house",
    });
  });

  it("reads the error, and prefers it over a stray token", () => {
    expect(readOidcReturn("#oidc_error=the%20house%20could%20not%20verify")).toEqual({
      error: "the house could not verify",
    });
    expect(readOidcReturn("#oidc_error=x&oidc=t")).toEqual({ error: "x" });
  });
});
