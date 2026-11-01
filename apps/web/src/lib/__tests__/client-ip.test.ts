// lib/client-ip.ts - the ONE client-IP reader the per-IP limiters key on (final review, S10 M1). The order is the deployment's,
// not the code's: on Fly the origin is reached DIRECTLY, so Fly's proxy writes `Fly-Client-IP` (a client cannot), while a
// client can write `CF-Connecting-IP` and the FIRST X-Forwarded-For hop itself (Fly appends to XFF, it does not replace it).
// So: Fly-Client-IP, then the first XFF hop, then X-Real-IP; `CF-Connecting-IP` only behind the explicit opt-in
// (`TRUST_CF_CONNECTING_IP=1`, for an origin reachable through Cloudflare alone), default OFF.
//
// Every limiter that keys on it moves with it: capture's failed-401 budget (`clientIpOf`, its route pin is
// limits-route.test.ts), the public read limiters (`publicClientIp`), and the /s/ redirect's miss budget and click dedupe.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The limiters' own call, recorded: the wiring `describe` reads which bucket each limiter keyed on.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: vi.fn(async () => undefined) };
});

import { rateLimit } from "@/lib/rate-limit";
import { clientIpOf } from "@/server/api-v1/capture-http";
import { publicPollRateLimit, publicRateLimit } from "@/server/usecases/public";
import { GET as sponsorLink } from "@/app/s/[key]/route";
import { clientIp, TRUST_CF_CONNECTING_IP_ENV } from "../client-ip";

const FLY = "198.51.100.60";
const CF = "203.0.113.50";
const XFF_FIRST = "192.0.2.7";
const REAL = "192.0.2.99";
const h = (o: Record<string, string>) => new Headers(o);

afterEach(() => vi.unstubAllEnvs());

describe("clientIp - Fly-Client-IP, then the first X-Forwarded-For hop, then X-Real-IP", () => {
  it("each header in turn, the next only when the one before is absent or blank (count reported)", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "fly-client-ip": FLY, "x-forwarded-for": `${XFF_FIRST}, 10.0.0.1`, "x-real-ip": REAL }, FLY],
      [{ "fly-client-ip": `  ${FLY}  ` }, FLY],
      [{ "fly-client-ip": "", "x-forwarded-for": `${XFF_FIRST}, 10.0.0.1`, "x-real-ip": REAL }, XFF_FIRST],
      [{ "x-forwarded-for": ` ${XFF_FIRST} ,10.0.0.1` }, XFF_FIRST],
      [{ "x-forwarded-for": "", "x-real-ip": REAL }, REAL],
      [{ "x-real-ip": ` ${REAL} ` }, REAL],
      [{}, "unknown"],
    ];
    let checked = 0;
    for (const [headers, want] of cases) {
      expect(clientIp(h(headers)), JSON.stringify(headers)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a FORGED CF-Connecting-IP does not win: not over Fly-Client-IP, not over the first XFF hop, not alone (the opt-in is off by default)", () => {
    expect(process.env[TRUST_CF_CONNECTING_IP_ENV], "premise: the test env sets no opt-in").toBeUndefined();
    expect(clientIp(h({ "cf-connecting-ip": CF, "fly-client-ip": FLY }))).toBe(FLY);
    expect(clientIp(h({ "cf-connecting-ip": CF, "x-forwarded-for": XFF_FIRST }))).toBe(XFF_FIRST);
    expect(clientIp(h({ "cf-connecting-ip": CF }))).toBe("unknown");
  });

  it("behind the opt-in (exactly \"1\") Cloudflare's header leads; any other value is off (count reported)", () => {
    vi.stubEnv(TRUST_CF_CONNECTING_IP_ENV, "1");
    expect(clientIp(h({ "cf-connecting-ip": CF, "fly-client-ip": FLY }))).toBe(CF);
    expect(clientIp(h({ "cf-connecting-ip": " ", "fly-client-ip": FLY })), "a blank CF header falls through").toBe(FLY);
    let off = 0;
    for (const v of ["", "0", "true", "yes"]) {
      vi.stubEnv(TRUST_CF_CONNECTING_IP_ENV, v);
      expect(clientIp(h({ "cf-connecting-ip": CF, "fly-client-ip": FLY })), `opt-in=${JSON.stringify(v)}`).toBe(FLY);
      off++;
    }
    expect(off).toBe(4);
    expect(TRUST_CF_CONNECTING_IP_ENV).toBe("TRUST_CF_CONNECTING_IP");
  });
});

describe("every limiter the batch names keys on it - a forged CF-Connecting-IP moves none of them (the real callers)", () => {
  const forged = (url = "http://x/any") => new Request(url, { headers: { "cf-connecting-ip": CF, "fly-client-ip": FLY, "x-forwarded-for": XFF_FIRST } });
  const keys = () => vi.mocked(rateLimit).mock.calls.map(([k]) => k);

  it("capture's failed-401 budget (clientIpOf), the public read limiters (publicClientIp) and the /s/ miss budget (count reported)", async () => {
    vi.mocked(rateLimit).mockClear();
    expect(clientIpOf(forged()), "capture").toBe(FLY);
    await publicRateLimit(forged());
    await publicPollRateLimit(forged());
    const res = await sponsorLink(forged("http://x/s/zz"), { params: Promise.resolve({ key: "zz" }) });
    expect(res.status, "premise: an id that names nothing is a miss").toBe(404);
    const digest = createHash("sha256").update(FLY).digest("hex");
    expect(keys()).toEqual([`pubv1:${FLY}`, `pubv1poll:${FLY}`, `s404:${digest}`]);
    expect(keys().length).toBe(3);
  });

  it("with the opt-in on, all of them move to Cloudflare's header together", async () => {
    vi.stubEnv(TRUST_CF_CONNECTING_IP_ENV, "1");
    vi.mocked(rateLimit).mockClear();
    expect(clientIpOf(forged())).toBe(CF);
    await publicRateLimit(forged());
    await sponsorLink(forged("http://x/s/zz"), { params: Promise.resolve({ key: "zz" }) });
    expect(keys()).toEqual([`pubv1:${CF}`, `s404:${createHash("sha256").update(CF).digest("hex")}`]);
  });
});
