// TEMP(RS004 variants) — this whole file is sign-off scaffold, deleted the
// same day registration-hub-variant.ts is (see that file's header comment).
//
// Mirrors registration-hub-tab.test.ts's own shape exactly: the `?variant=`
// whitelist is the SAME kind of pure, dependency-free derivation as `?tab=`,
// tested the same way (dispatch requirement: proven directly, not only
// through the page).
import { describe, expect, it } from "vitest";
import {
  REGISTRATION_HUB_VARIANTS,
  resolveRegistrationHubVariant,
} from "@/components/registration-hub-variant";

describe("resolveRegistrationHubVariant", () => {
  it("defaults to 'a' when no variant is requested", () => {
    expect(resolveRegistrationHubVariant(undefined)).toBe("a");
  });

  it("falls back to 'a' on an unrecognised variant value", () => {
    expect(resolveRegistrationHubVariant("bogus")).toBe("a");
  });

  it("falls back to 'a' on an empty string", () => {
    expect(resolveRegistrationHubVariant("")).toBe("a");
  });

  it("honours an explicit ?variant=a", () => {
    expect(resolveRegistrationHubVariant("a")).toBe("a");
  });

  it("honours an explicit ?variant=b", () => {
    expect(resolveRegistrationHubVariant("b")).toBe("b");
  });

  it("honours an explicit ?variant=c", () => {
    expect(resolveRegistrationHubVariant("c")).toBe("c");
  });

  it("exposes exactly the three variants, control first", () => {
    expect(REGISTRATION_HUB_VARIANTS).toEqual(["a", "b", "c"]);
  });

  // Same characterisation shape as resolveRegistrationHubTab's own tests —
  // the whitelist `.includes()` check is safe by construction against any
  // value it does not recognise.
  it("characterisation: falls back to 'a' on a case-varying ?variant=B — no case-insensitive matching", () => {
    expect(resolveRegistrationHubVariant("B")).toBe("a");
  });

  it("characterisation: falls back to 'a' on Next's array-valued repeated ?variant=b&variant=c", () => {
    expect(resolveRegistrationHubVariant(["b", "c"] as unknown as string)).toBe("a");
  });
});
