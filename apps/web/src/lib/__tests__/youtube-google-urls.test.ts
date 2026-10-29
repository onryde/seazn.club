// YouTube Connect, B6 batch review (URL constants): the page where a person removes Seazn from their Google account is ONE link.
// `lib/youtube.ts` once carried two constants for it (the Developer Policies' old `security.google.com/settings/security/permissions`
// and the Disconnect notice's `myaccount.google.com/connections`), so a page could link either. The owner kept the connections page.
//
// The expected URL is Google's own account page, typed here and never read back from the module. The sweep goes over EVERY export of the
// module (not a hand-kept list), so a second constant for the same page cannot come back under a new name.
// No database, no sport: constants.
import { describe, expect, it } from "vitest";
import * as youtube from "../youtube";

/** Where a Google account lists, and removes, the third-party apps it has granted access to. */
const THIRD_PARTY_ACCESS = "https://myaccount.google.com/connections";
/** A URL on one of Google's account-management hosts. */
const ACCOUNT_PAGE = /^https?:\/\/(?:myaccount|security|accounts)\.google\.com\//;

describe("lib/youtube: the Google account-access link is one constant", () => {
  it("EMPTY CASE FIRST: the module exports strings at all (a sweep over nothing would pass)", () => {
    const strings = Object.values(youtube).flatMap((v) => (typeof v === "string" ? [v] : []));
    expect(strings.length).toBeGreaterThan(5);
  });

  it("exactly ONE exported constant points at a Google account page, and it is the connections page", () => {
    const hits = Object.entries(youtube).filter(([, v]) => typeof v === "string" && ACCOUNT_PAGE.test(v));
    expect(hits.map(([, v]) => v), "one constant, one page").toEqual([THIRD_PARTY_ACCESS]);
  });
});
