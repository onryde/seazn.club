// Blog P2 Task 5, fix round 1 (review I1): /help and /blog are cached at Cloudflare's edge, and Cloudflare ignores
// `Vary`. A flight (RSC) request is the same URL with an `rsc: 1` header; if Next answered it with the flight payload
// and `s-maxage`, the edge would store that payload under the page's URL and serve it to the next visitor as the page.
// Next's guard is `experimental.validateRSCRequestHeaders`: an RSC request whose `_rsc` query does not carry the hash
// of its headers gets a 307 to the hashed URL instead (next/dist/server/base-server.js). Next 16.3.6 defaults it to
// true; earlier 16.x defaulted it on only for test, canary and local dev. So it is set EXPLICITLY, and pinned here,
// so a Next upgrade or a config edit cannot turn it off without this going red. The resolved value of a real build is
// read from `.next/required-server-files.json` in task-5-report.md (fix round 1).
//
// Single-sport reason: no sport is involved; this is framework configuration.
import { describe, expect, it } from "vitest";
import { nextConfig } from "../../../next.config.js";

describe("next.config: RSC request validation", () => {
  it("is set explicitly to true (never left to Next's default)", () => {
    const experimental = (nextConfig as { experimental?: Record<string, unknown> }).experimental ?? {};
    expect(Object.hasOwn(experimental, "validateRSCRequestHeaders"), "set in next.config.js, not inherited").toBe(true);
    expect(experimental.validateRSCRequestHeaders).toBe(true);
  });
});
