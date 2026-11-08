// lib/client-ip.ts - the ONE client-IP reader the per-IP limiters key on (final review S10 M1; re-review N1). The order is the
// deployment's, not the code's: seazn.club and stg are served THROUGH Cloudflare to Fly (`server: cloudflare`, `cf-ray`,
// `via: 1.1 fly.io`), so the peer Fly's proxy sees - and writes into `Fly-Client-IP`, which a client cannot set - is a
// Cloudflare edge, and the real client is Cloudflare's `CF-Connecting-IP`. But the `*.fly.dev` origins answer directly, where a
// client CAN write `CF-Connecting-IP` itself. So Cloudflare's header is believed only when Fly's peer is inside Cloudflare's
// published ranges; otherwise Fly's peer is the client. With no Fly header at all (local, CI) the first X-Forwarded-For hop,
// then X-Real-IP, then "unknown".
//
// Expected values: the ranges are Cloudflare's published lists (https://www.cloudflare.com/ips-v4, /ips-v6), the edges are
// each range's first and last address and the addresses either side - arithmetic on the published CIDR, not the code's.
//
// Every limiter that keys on it moves with it: capture's failed-401 budget (`clientIpOf`, its route pin is
// limits-route.test.ts), the public read limiters (`publicClientIp`), and the /s/ redirect's miss budget and click dedupe.
// The auth, registration, device-link, consent, funnel and format-preview limiters are pinned in client-ip-limiters.test.ts,
// and client-ip-readers.test.ts fails any other source file that reads one of these headers itself.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The limiters' own call, recorded: the wiring `describe` reads which bucket each limiter keyed on.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: vi.fn(async () => undefined) };
});

import { rateLimit } from "@/lib/rate-limit";
import { clientIp, CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, isCloudflarePeer } from "../client-ip";
import { clientIpOf } from "@/server/api-v1/capture-http";
import { publicPollRateLimit, publicRateLimit } from "@/server/usecases/public";
import { GET as sponsorLink } from "@/app/s/[key]/route";

/** A Cloudflare edge, as Fly's proxy sees it (162.158.0.0/15). */
const CF_EDGE = "162.158.12.34";
/** A Cloudflare edge over IPv6 (2606:4700::/32). */
const CF_EDGE6 = "2606:4700:10::ac43:1";
/** The visitor, as Cloudflare names them. */
const VISITOR = "203.0.113.50";
const VISITOR6 = "2001:db8:1::7";
/** A client reaching the fly.dev origin directly: not Cloudflare. */
const DIRECT = "198.51.100.60";
const XFF_FIRST = "192.0.2.7";
const REAL = "192.0.2.99";
const h = (o: Record<string, string>) => new Headers(o);

// Every test outside the origin-stamp describe runs with the secret UNSET - today's deployment - whatever a developer's
// .env.local (vitest.config.ts loads it) holds; that describe sets it per test. Unstubbed after each.
beforeEach(() => vi.stubEnv("CF_ORIGIN_SECRET", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("Cloudflare's published ranges (fetched 2026-11-01)", () => {
  it("are the published lists: 15 IPv4 and 7 IPv6 CIDRs, each a valid network of its family (count reported)", () => {
    expect(CLOUDFLARE_IPV4_RANGES).toHaveLength(15);
    expect(CLOUDFLARE_IPV6_RANGES).toHaveLength(7);
    let checked = 0;
    for (const [list, family, bits] of [[CLOUDFLARE_IPV4_RANGES, 4, 32], [CLOUDFLARE_IPV6_RANGES, 6, 128]] as const) {
      for (const cidr of list) {
        const [net, len] = cidr.split("/");
        expect(isIP(net!), cidr).toBe(family);
        expect(Number(len) >= 8 && Number(len) <= bits, cidr).toBe(true);
        // Each range's own network address is a Cloudflare peer: the sweep reaches every row.
        expect(isCloudflarePeer(net!), cidr).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(22);
  });

  it("the edges, both families: a range's first and last address are in, the address either side is out (count reported)", () => {
    const cases: Array<[string, boolean]> = [
      // 162.158.0.0/15: 162.158.0.0 .. 162.159.255.255
      ["162.158.0.0", true], ["162.159.255.255", true], ["162.157.255.255", false], ["162.160.0.0", false],
      // 104.16.0.0/13: 104.16.0.0 .. 104.23.255.255, then 104.24.0.0/14 starts - adjacent ranges
      ["104.23.255.255", true], ["104.24.0.0", true], ["104.27.255.255", true], ["104.28.0.0", false], ["104.15.255.255", false],
      // 131.0.72.0/22: 131.0.72.0 .. 131.0.75.255
      ["131.0.72.0", true], ["131.0.75.255", true], ["131.0.71.255", false], ["131.0.76.0", false],
      // 2a06:98c0::/29: 2a06:98c0:: .. 2a06:98c7:ffff:ffff:ffff:ffff:ffff:ffff
      ["2a06:98c0::", true], ["2a06:98c7:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2a06:98bf:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2a06:98c8::", false],
      // 2606:4700::/32, any case
      ["2606:4700:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2606:4701::", false], ["2606:4700::AC43:1", true],
      // An IPv4-mapped IPv6 peer is its IPv4 address.
      ["::ffff:162.158.1.1", true], ["::ffff:198.51.100.60", false],
      // Not an address at all.
      ["", false], ["garbage", false], ["162.158.1.1 ", false], ["162.158.1.1/15", false],
    ];
    let checked = 0;
    for (const [ip, inside] of cases) {
      expect(isCloudflarePeer(ip), JSON.stringify(ip)).toBe(inside);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});

describe("clientIp", () => {
  it("1. a Cloudflare peer with CF-Connecting-IP: Cloudflare's visitor wins, over IPv4 and IPv6 peers and visitors (count reported)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "x-forwarded-for": `${XFF_FIRST}, ${CF_EDGE}` }, VISITOR],
      [{ "fly-client-ip": CF_EDGE6, "cf-connecting-ip": VISITOR }, VISITOR],
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR6 }, VISITOR6],
      [{ "fly-client-ip": ` ${CF_EDGE} `, "cf-connecting-ip": ` ${VISITOR} ` }, VISITOR],
      [{ "fly-client-ip": "104.27.255.255", "cf-connecting-ip": VISITOR }, VISITOR],
    ];
    let checked = 0;
    for (const [headers, want] of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("2. a peer OUTSIDE Cloudflare with a forged CF-Connecting-IP: Fly's peer wins - IPv4, IPv6, a range's neighbour; and a CF peer with no CF header is itself (count reported)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "fly-client-ip": DIRECT, "cf-connecting-ip": VISITOR, "x-forwarded-for": XFF_FIRST }, DIRECT],
      [{ "fly-client-ip": VISITOR6, "cf-connecting-ip": VISITOR }, VISITOR6],
      [{ "fly-client-ip": "162.160.0.0", "cf-connecting-ip": VISITOR }, "162.160.0.0"],
      [{ "fly-client-ip": "2a06:98c8::", "cf-connecting-ip": VISITOR }, "2a06:98c8::"],
      [{ "fly-client-ip": CF_EDGE }, CF_EDGE],
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": " " }, CF_EDGE],
    ];
    let checked = 0;
    for (const [headers, want] of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  // Security re-review: a Cloudflare Worker's fetch() to the fly.dev origin leaves from Cloudflare's own ranges and can set
  // CF-Connecting-IP to anything; Cloudflare marks every Worker subrequest with `cf-worker`. And a CF value that is not an
  // address never becomes a bucket key.
  it("2b. a Cloudflare peer whose CF-Connecting-IP cannot be believed - a Worker subrequest (cf-worker, any value) or not an address: Fly's peer (count reported)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "cf-worker": "attacker.example" }, CF_EDGE],
      [{ "fly-client-ip": CF_EDGE6, "cf-connecting-ip": VISITOR6, "cf-worker": "" }, CF_EDGE6],
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "evil" }, CF_EDGE],
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }, CF_EDGE],
      [{ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "203.0.113.50/32" }, CF_EDGE],
    ];
    let checked = 0;
    for (const [headers, want] of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The positive pair: the same edge, an address, no cf-worker - the visitor.
    expect(clientIp(h({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR }))).toBe(VISITOR);
  });

  it("3. no Fly header (local, CI): the first X-Forwarded-For hop, then X-Real-IP; a CF header with no Fly peer to vouch for it is ignored (count reported)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "x-forwarded-for": ` ${XFF_FIRST} ,10.0.0.1`, "x-real-ip": REAL }, XFF_FIRST],
      [{ "fly-client-ip": "", "x-forwarded-for": XFF_FIRST }, XFF_FIRST],
      [{ "cf-connecting-ip": VISITOR, "x-forwarded-for": XFF_FIRST }, XFF_FIRST],
      [{ "x-forwarded-for": "", "x-real-ip": ` ${REAL} ` }, REAL],
      [{ "cf-connecting-ip": VISITOR, "x-real-ip": REAL }, REAL],
    ];
    let checked = 0;
    for (const [headers, want] of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("4. nothing usable: \"unknown\" - no header, blank headers, or Cloudflare's header alone (count reported)", () => {
    const cases: Array<Record<string, string>> = [{}, { "fly-client-ip": " ", "x-forwarded-for": " ", "x-real-ip": "" }, { "cf-connecting-ip": VISITOR }];
    let checked = 0;
    for (const headers of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe("unknown");
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});

// The origin stamp (owner OK 2026-11-07). Anyone with a Cloudflare zone of their own can send requests to the fly.dev origin
// THROUGH Cloudflare's network: the peer is a genuine Cloudflare edge, there is no `cf-worker`, and `CF-Connecting-IP` says
// whatever they chose. Only OUR zone's Transform Rule stamps `x-seazn-origin-secret` with the value held in the
// `CF_ORIGIN_SECRET` Fly secret, so with the secret set, Cloudflare's header is believed only on a request that carries that
// exact stamp. A missing or wrong stamp falls back to Fly's peer - never a refusal. Unset, nothing changes. The header name and
// the fallback are the brief's (README "Deploy step - client IP behind Cloudflare"), typed here, not read from the module.
// The name carries `secret` so Sentry's own deny list masks it (fix round 1, I1; scrub-score-url.test.ts holds that proof).
describe("the origin stamp: CF_ORIGIN_SECRET and x-seazn-origin-secret", () => {
  /** A 64-character hex value, the shape `openssl rand -hex 32` gives the runbook. */
  const SECRET = "0123456789abcdef".repeat(4);
  /** A visitor named by ANOTHER Cloudflare zone's request to our origin - any value its owner picked. */
  const FORGED = "192.0.2.200";
  const stamped = (o: Record<string, string>, stamp = SECRET) => h({ ...o, "x-seazn-origin-secret": stamp });
  const run = (cases: Array<[Headers, string, string]>): number => {
    let checked = 0;
    for (const [headers, want, label] of cases) {
      expect(clientIp(headers), label).toBe(want);
      checked++;
    }
    return checked;
  };

  it("set, and the stamp matches: Cloudflare's visitor, IPv4 and IPv6, a forged X-Forwarded-For hop beside it (count reported)", () => {
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    const cases: Array<[Headers, string, string]> = [
      [stamped({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR }), VISITOR, "v4 peer, v4 visitor"],
      [stamped({ "fly-client-ip": CF_EDGE6, "cf-connecting-ip": VISITOR6 }), VISITOR6, "v6 peer, v6 visitor"],
      [stamped({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "x-forwarded-for": `${XFF_FIRST}, ${CF_EDGE}` }), VISITOR, "XFF beside it"],
    ];
    expect(run(cases)).toBe(3);
  });

  it("set, and the stamp is missing, wrong at the same length, or another length: Fly's peer, and none of them throws (count reported)", () => {
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    const base = { "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR };
    const cases: Array<[Headers, string, string]> = [
      [h(base), CF_EDGE, "missing"],
      [stamped(base, `${SECRET.slice(0, -1)}0`), CF_EDGE, "same length, last character wrong"],
      [stamped(base, `f${SECRET.slice(1)}`), CF_EDGE, "same length, first character wrong"],
      [stamped(base, SECRET.toUpperCase()), CF_EDGE, "same length, another case"],
      [stamped(base, SECRET.slice(0, -1)), CF_EDGE, "one character short"],
      [stamped(base, `${SECRET}0`), CF_EDGE, "one character long"],
      [stamped(base, SECRET.slice(0, 32)), CF_EDGE, "a prefix"],
      [stamped(base, SECRET + SECRET), CF_EDGE, "the secret twice"],
      [stamped(base, ""), CF_EDGE, "empty"],
      // The pre-rename name (6c336f65c9): a rule built from that README revision stamps a header web no longer reads.
      [h({ ...base, "x-seazn-origin": SECRET }), CF_EDGE, "the right value under the pre-rename name x-seazn-origin"],
    ];
    expect(SECRET.toUpperCase(), "premise: the case-flipped stamp differs").not.toBe(SECRET);
    expect(run(cases)).toBe(10);
  });

  it("a CF-Connecting-IP forged through ANOTHER zone (a Cloudflare-range peer, no cf-worker, no stamp): Fly's peer once the secret is set - and the forged value while it is not, the gap this closes", () => {
    const fromAnotherZone = [
      h({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": FORGED }),
      h({ "fly-client-ip": CF_EDGE6, "cf-connecting-ip": FORGED }),
    ];
    expect(fromAnotherZone.map(clientIp), "unset: today's behaviour believes it").toEqual([FORGED, FORGED]);
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    expect(fromAnotherZone.map(clientIp), "set: Fly's peer").toEqual([CF_EDGE, CF_EDGE6]);
  });

  it("is in ADDITION to the existing checks: a matching stamp never rescues a non-Cloudflare peer, a Worker subrequest or a non-address (count reported)", () => {
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    const cases: Array<[Headers, string, string]> = [
      [stamped({ "fly-client-ip": DIRECT, "cf-connecting-ip": VISITOR }), DIRECT, "peer outside Cloudflare"],
      [stamped({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "cf-worker": "attacker.example" }), CF_EDGE, "a Worker subrequest"],
      [stamped({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "evil" }), CF_EDGE, "not an address"],
      [stamped({ "fly-client-ip": CF_EDGE }), CF_EDGE, "no CF header at all"],
    ];
    expect(run(cases)).toBe(4);
  });

  it("with no Fly header (local, CI) the secret changes nothing: X-Forwarded-For, then X-Real-IP, then \"unknown\"; a stamped CF header with no Fly peer is still ignored (count reported)", () => {
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    const cases: Array<[Headers, string, string]> = [
      [h({ "x-forwarded-for": `${XFF_FIRST}, 10.0.0.1` }), XFF_FIRST, "XFF"],
      [h({ "x-real-ip": REAL }), REAL, "X-Real-IP"],
      [stamped({ "cf-connecting-ip": VISITOR, "x-forwarded-for": XFF_FIRST }), XFF_FIRST, "stamped CF, no Fly peer"],
      [stamped({ "cf-connecting-ip": VISITOR }), "unknown", "stamped CF alone"],
    ];
    expect(run(cases)).toBe(4);
  });

  it("unset or empty, the stamp is not required and a stamp of any value changes nothing - today's behaviour (count reported)", () => {
    const base = { "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR };
    let checked = 0;
    for (const secret of [undefined, ""]) {
      vi.stubEnv("CF_ORIGIN_SECRET", secret);
      checked += run([
        [h(base), VISITOR, `${JSON.stringify(secret)}: no stamp`],
        [stamped(base, "anything"), VISITOR, `${JSON.stringify(secret)}: a stamp`],
        [stamped(base, ""), VISITOR, `${JSON.stringify(secret)}: an empty stamp`],
      ]);
    }
    expect(checked).toBe(6);
  });

  it("is read per request, not at module load: the same request moves as the secret is set, unset and set to another value", () => {
    const req = stamped({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR });
    const seen: string[] = [];
    seen.push(clientIp(req));
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET);
    seen.push(clientIp(req));
    vi.stubEnv("CF_ORIGIN_SECRET", "another-secret-of-another-environment");
    seen.push(clientIp(req));
    vi.stubEnv("CF_ORIGIN_SECRET", undefined);
    seen.push(clientIp(req));
    expect(seen).toEqual([VISITOR, VISITOR, CF_EDGE, VISITOR]);
  });
});

describe("every limiter the batch names keys on it (the real callers)", () => {
  const req = (headers: Record<string, string>, url = "http://x/any") => new Request(url, { headers });
  const keys = () => vi.mocked(rateLimit).mock.calls.map(([k]) => k);
  const allOf = async (headers: Record<string, string>) => {
    vi.mocked(rateLimit).mockClear();
    const capture = clientIpOf(req(headers));
    await publicRateLimit(req(headers));
    await publicPollRateLimit(req(headers));
    const res = await sponsorLink(req(headers, "http://x/s/zz"), { params: Promise.resolve({ key: "zz" }) });
    expect(res.status, "premise: an id that names nothing is a miss").toBe(404);
    return { capture, keys: keys() };
  };
  const bucketsOf = (ip: string) => [`pubv1:${ip}`, `pubv1poll:${ip}`, `s404:${createHash("sha256").update(ip).digest("hex")}`];

  it("behind Cloudflare, each visitor is their own bucket in capture's failed-401 budget, the public read limiters and the /s/ miss budget - never the edge's", async () => {
    const one = await allOf({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR });
    expect(one).toEqual({ capture: VISITOR, keys: bucketsOf(VISITOR) });
    const two = await allOf({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR6 });
    expect(two, "a second visitor through the SAME edge is another bucket").toEqual({ capture: VISITOR6, keys: bucketsOf(VISITOR6) });
  });

  it("straight to the origin, a forged CF-Connecting-IP moves none of them: Fly's peer keys every one", async () => {
    const got = await allOf({ "fly-client-ip": DIRECT, "cf-connecting-ip": VISITOR, "x-forwarded-for": XFF_FIRST });
    expect(got).toEqual({ capture: DIRECT, keys: bucketsOf(DIRECT) });
  });
});
