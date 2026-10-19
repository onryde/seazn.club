// isSameOriginRequest — the proof the claim accept route asks of a request that is about to mint a session
// (PR #991 review). The decision table is declared here, one row per header shape, and the test reports how
// many rows it walked (zero would be a vacuous pass).
import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "@/lib/same-origin";

const TABLE: { name: string; headers: Record<string, string>; ok: boolean }[] = [
  { name: "same-origin fetch from our own page", headers: { "sec-fetch-site": "same-origin" }, ok: true },
  { name: "same-origin, Origin also sent", headers: { "sec-fetch-site": "same-origin", origin: "https://seazn.club" }, ok: true },
  { name: "older browser: Origin only (proxy.ts matched its host)", headers: { origin: "https://seazn.club" }, ok: true },
  { name: "no Origin and no Sec-Fetch-Site (curl, an API client, a stripped request)", headers: {}, ok: false },
  { name: "cross-site", headers: { "sec-fetch-site": "cross-site" }, ok: false },
  { name: "same-site: a sibling subdomain is not our page", headers: { "sec-fetch-site": "same-site" }, ok: false },
  { name: "none: user-initiated navigation cannot be a POST from our page", headers: { "sec-fetch-site": "none" }, ok: false },
  { name: "Sec-Fetch-Site wins over a present Origin", headers: { "sec-fetch-site": "cross-site", origin: "https://seazn.club" }, ok: false },
  { name: "empty Sec-Fetch-Site value is not same-origin", headers: { "sec-fetch-site": "" }, ok: false },
];

describe("isSameOriginRequest", () => {
  it.each(TABLE)("$name", ({ headers, ok }) => {
    expect(isSameOriginRequest(new Headers(headers))).toBe(ok);
  });

  it("walked both outcomes (anti-vacuity)", () => {
    expect(TABLE.filter((r) => r.ok).length).toBeGreaterThan(0);
    expect(TABLE.filter((r) => !r.ok).length).toBeGreaterThan(0);
  });
});
