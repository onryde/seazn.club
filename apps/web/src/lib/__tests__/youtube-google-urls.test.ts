// YouTube Connect, B6 batch review (URL constants): the page where a person removes Seazn from their Google account is ONE link.
// `lib/youtube.ts` once carried two constants for it (the Developer Policies' `security.google.com/settings/security/permissions` and the
// Disconnect notice's `myaccount.google.com/connections`), so a page could link either. B6 kept the connections page; T19 fix round 1
// (PO ruling, after reading the policy) reversed that: the privacy policy must link the URL the policy names (DP III.A.2.h), and the
// Disconnect notice is the same place, so the ONE constant is the policy's URL.
//
// The expected URL is the Developer Policies' own literal (developers.google.com/youtube/terms/developer-policies III.A.2.h, read
// 2026-10-29), typed here and never read back from the module. The sweep goes over EVERY export of the module (not a hand-kept list), so
// a second constant for the same page cannot come back under a new name.
// No database, no sport: constants.
import { describe, expect, it } from "vitest";
import * as youtube from "../youtube";

/** Where the Developer Policies (III.A.2.h) say a user revokes an app's access: Google's security-permissions page. */
const THIRD_PARTY_ACCESS = "https://security.google.com/settings/security/permissions";
/** A URL on one of Google's account-management hosts. */
const ACCOUNT_PAGE = /^https?:\/\/(?:myaccount|security|accounts)\.google\.com\//;

describe("lib/youtube: the Google account-access link is one constant", () => {
  it("EMPTY CASE FIRST: the module exports strings at all (a sweep over nothing would pass)", () => {
    const strings = Object.values(youtube).flatMap((v) => (typeof v === "string" ? [v] : []));
    expect(strings.length).toBeGreaterThan(5);
  });

  it("exactly ONE exported constant points at a Google account page, and it is the page the Developer Policies name", () => {
    const hits = Object.entries(youtube).filter(([, v]) => typeof v === "string" && ACCOUNT_PAGE.test(v));
    expect(hits.map(([, v]) => v), "one constant, one page").toEqual([THIRD_PARTY_ACCESS]);
  });
});
