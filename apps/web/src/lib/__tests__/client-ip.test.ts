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
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { describe, expect, it, vi } from "vitest";

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
