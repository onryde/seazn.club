// Review m4 (PR #986): "Switch account" sends the player to /login?next=<the room's path AND query>, and the query is the
// personal link - a signed match-room token that opens the seat. The login page is a pageview like any other, so its URL goes
// through the telemetry scrub (PostHog, Sentry, replay). Pinned on a REAL minted token (never a made-up string), through the
// button's own href builder: the token must not survive the scrub, in either of the shapes it travels.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { scrubScoreUrl, scrubScoreTokens } from "@/lib/scrub-score-url";
import { switchAccountHref } from "../switch-account-button";

async function realToken(): Promise<string> {
  return mintMatchRoomToken({
    fixtureId: randomUUID(),
    personId: randomUUID(),
    roundOpenId: randomUUID(),
    roundOpenedAt: new Date().toISOString(),
  });
}

/** The three dot-separated segments of the JWT: any of them surviving is a leak (the signature alone is the credential). */
const segments = (token: string) => token.split(".");

describe("the Switch account href, scrubbed", () => {
  it("a real minted token: the login URL carries it (premise), and the scrub leaves none of it - not the token, not any of its three segments", async () => {
    const token = await realToken();
    expect(segments(token), "premise: a real JWT").toHaveLength(3);
    expect(token.length, "premise: the long token the owner saw (~370 chars)").toBeGreaterThan(200);
    const next = `/shared/org/comp/div/fixtures/${randomUUID()}/play?t=${encodeURIComponent(token)}`;
    const href = switchAccountHref(next);
    expect(href, "premise: the href holds the token before the scrub").toContain(token);
    const scrubbed = scrubScoreUrl(href);
    expect(scrubbed).not.toContain(token);
    for (const seg of segments(token)) expect(scrubbed, `segment ${seg.slice(0, 8)}…`).not.toContain(seg);
    expect(scrubbed, "and says where it was").toContain("[token]");
    expect(scrubbed, "the rest of the URL is left alone: the login page and where it lands").toMatch(/^\/login\?next=%2Fshared%2Forg%2Fcomp%2Fdiv%2Ffixtures%2F[0-9a-f-]{36}%2Fplay%3Ft%3D\[token\]$/);
  });

  it("the same, with the token somewhere other than last in the query, and through the JSON walk the SDKs use", async () => {
    const token = await realToken();
    const href = switchAccountHref(`/play?lang=fr&t=${encodeURIComponent(token)}&x=1`);
    const scrubbed = scrubScoreUrl(href);
    expect(scrubbed).not.toContain(segments(token)[2]!);
    expect(scrubbed).toContain("%26x%3D1");
    const walked = JSON.stringify(scrubScoreTokens({ $current_url: href, nested: [{ referrer: href }] }));
    for (const seg of segments(token)) expect(walked, "a nested value too").not.toContain(seg);
  });

  it("the sequence: two different real tokens, each scrubbed on its own - neither survives, and the scrub is not a no-op on a link with no token (the empty case)", async () => {
    const [a, b] = [await realToken(), await realToken()];
    expect(a).not.toBe(b);
    for (const token of [a, b]) {
      expect(scrubScoreUrl(switchAccountHref(`/play?t=${encodeURIComponent(token)}`))).not.toContain(segments(token)[2]!);
    }
    const plain = switchAccountHref("/shared/org/comp/div/fixtures/f1/play");
    expect(scrubScoreUrl(plain), "no token, nothing to change").toBe(plain);
  });
});
