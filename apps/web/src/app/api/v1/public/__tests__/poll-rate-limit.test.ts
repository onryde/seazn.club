// The public endpoints a page polls on a timer get their OWN per-IP bucket,
// 300 requests a minute; every other public endpoint keeps the 60 a minute of
// doc 08 §6 (owner ruling 2026-09-17). An open hub polls every few seconds and
// can also refetch on each push, so a household or a venue behind one IP
// crossed 60 a minute with a single page open.
//
// The polled endpoints, found from the client code (each fetch below is driven
// by a `setInterval` in the named hook):
//   - GET /public/fixtures/{id}                 use-live-fixture.ts (the match centre)
//   - GET /public/fixtures/{id}/overlay         the same hook, overlay-stage.tsx's fetcher
//   - GET /public/orgs/{org}/competitions/{slug}/hub                    use-live-competition.ts
//   - GET /public/orgs/{org}/competitions/{slug}/players/{id}/matches   use-live-player-matches.ts
//   - GET /public/orgs/{org}/live               org-live-chips.tsx
// Not polled: /public/fixtures/{id}/realtime-token is fetched once per
// subscription (use-live-fixture.ts, use-fixture-stream.ts), never on a timer,
// so it stays on the 60 bucket.
//
// NOT_POLLED lists EVERY other route that calls `publicRateLimit` (13 of them,
// review r2-m2), so moving any one of them to the poll bucket fails here.
// register, register/join and by-ref/withdraw keep their own `rateLimit`
// buckets and are out of scope.
//
// Driven through the REAL route handlers and the REAL limiter
// (`@/lib/rate-limit`); only Redis's INCR is an in-memory counter, and the
// usecases behind each route are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  },
}));
const usecase = vi.hoisted(() => ({
  publicFixture: vi.fn(async () => ({ id: "f1" })),
  publicCompetitionHub: vi.fn(async () => ({ competitionId: "c1" })),
  publicPlayerMatches: vi.fn(async () => ({ matches: [] })),
  publicOrgLive: vi.fn(async () => ({ competitions: [] })),
  publicStandings: vi.fn(async () => ({ rows: [] })),
  publicCompetition: vi.fn(async () => ({ id: "c1" })),
  loadOverlayLiveData: vi.fn(async () => ({ id: "f1" })),
  discoveryList: vi.fn(async () => ({ items: [], nextOffset: null })),
  publicEntrants: vi.fn(async () => ({ entrants: [] })),
  publicSchedule: vi.fn(async () => ({ fixtures: [] })),
  publicDivisionStats: vi.fn(async () => ({ leaders: [] })),
  publicRegistrationInfo: vi.fn(async () => ({ divisions: [] })),
  publicRegistrationStatus: vi.fn(async () => ({ status: "confirmed" })),
  reconcileRegistration: vi.fn(async () => false),
  registrationIcs: vi.fn(async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR"),
  resumeRegistrationCheckout: vi.fn(async () => ({ url: "https://checkout.example" })),
  withdrawRegistrationPublic: vi.fn(async () => ({ withdrawn: true })),
  resendRegistrationConfirmationPublic: vi.fn(async () => ({ sent: true })),
  fixtureRealtimeEligible: vi.fn(async () => true),
  mintPublicFixtureToken: vi.fn(async () => "token"),
}));
vi.mock("@/server/usecases/public", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/public")>()),
  publicFixture: usecase.publicFixture,
  publicCompetitionHub: usecase.publicCompetitionHub,
  publicPlayerMatches: usecase.publicPlayerMatches,
  publicOrgLive: usecase.publicOrgLive,
  publicStandings: usecase.publicStandings,
  publicCompetition: usecase.publicCompetition,
  discoveryList: usecase.discoveryList,
  publicEntrants: usecase.publicEntrants,
  publicSchedule: usecase.publicSchedule,
}));
vi.mock("@/server/overlay/load", () => ({ loadOverlayLiveData: usecase.loadOverlayLiveData }));
vi.mock("@/server/usecases/player-stats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/player-stats")>()),
  publicDivisionStats: usecase.publicDivisionStats,
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  publicRegistrationInfo: usecase.publicRegistrationInfo,
  publicRegistrationStatus: usecase.publicRegistrationStatus,
  reconcileRegistration: usecase.reconcileRegistration,
  registrationIcs: usecase.registrationIcs,
  resumeRegistrationCheckout: usecase.resumeRegistrationCheckout,
  withdrawRegistrationPublic: usecase.withdrawRegistrationPublic,
  resendRegistrationConfirmationPublic: usecase.resendRegistrationConfirmationPublic,
}));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  fixtureRealtimeEligible: usecase.fixtureRealtimeEligible,
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  mintPublicFixtureToken: usecase.mintPublicFixtureToken,
}));

import { publicPollRateLimit, publicRateLimit } from "@/server/usecases/public";
import { GET as fixture } from "../fixtures/[id]/route";
import { GET as overlay } from "../fixtures/[id]/overlay/route";
import { GET as hub } from "../orgs/[orgSlug]/competitions/[slug]/hub/route";
import { GET as playerMatches } from "../orgs/[orgSlug]/competitions/[slug]/players/[personId]/matches/route";
import { GET as orgLive } from "../orgs/[orgSlug]/live/route";
import { GET as standings } from "../orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/standings/route";
import { GET as competition } from "../orgs/[orgSlug]/competitions/[slug]/route";
import { GET as discovery } from "../discovery/route";
import { GET as realtimeToken } from "../fixtures/[id]/realtime-token/route";
import { GET as entrants } from "../orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/entrants/route";
import { GET as schedule } from "../orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/schedule/route";
import { GET as stats } from "../orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/stats/route";
import { GET as registrationInfo } from "../orgs/[orgSlug]/competitions/[slug]/registration/route";
import { GET as registrationStatus } from "../registrations/[id]/route";
import { GET as registrationIcs } from "../registrations/[id]/ics/route";
import { POST as checkout } from "../registrations/[id]/checkout/route";
import { POST as withdraw } from "../registrations/[id]/withdraw/route";
import { POST as resend } from "../registrations/groups/[id]/resend/route";

type Call = (ip: string) => Promise<Response>;
const from = (ip: string) => new Request("http://x/api/v1/public/any", { headers: { "x-forwarded-for": ip } });
const params = <P,>(p: P) => ({ params: Promise.resolve(p) });
const REG = "00000000-0000-4000-8000-000000000001";
const TOKEN = "registrant-token-0123456789";
const withToken = (ip: string) =>
  new Request(`http://x/api/v1/public/any?token=${TOKEN}`, { headers: { "x-forwarded-for": ip } });
const posted = (ip: string) =>
  new Request("http://x/api/v1/public/any", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
const division = { orgSlug: "o", slug: "c", divisionSlug: "d" };

const POLLED: Array<[string, Call]> = [
  ["fixtures/{id}", (ip) => fixture(from(ip), params({ id: "f1" }))],
  ["fixtures/{id}/overlay", (ip) => overlay(from(ip), params({ id: "f1" }))],
  ["competitions/{slug}/hub", (ip) => hub(from(ip), params({ orgSlug: "o", slug: "c" }))],
  [
    "competitions/{slug}/players/{id}/matches",
    (ip) => playerMatches(from(ip), params({ orgSlug: "o", slug: "c", personId: "p1" })),
  ],
  ["orgs/{org}/live", (ip) => orgLive(from(ip), params({ orgSlug: "o" }))],
];
// A third element names the route's OWN tighter per-IP bucket, spent on top of
// the 60 (bot hardening 2026-09-25); registrations/__tests__/route-rate-limits
// .test.ts pins those. The 60-bucket case below empties it before each request
// so it still measures the 60 bucket alone.
const NOT_POLLED: Array<[string, Call, string?]> = [
  ["divisions/{div}/standings", (ip) => standings(from(ip), params(division))],
  ["competitions/{slug}", (ip) => competition(from(ip), params({ orgSlug: "o", slug: "c" }))],
  ["discovery", (ip) => discovery(from(ip))],
  ["fixtures/{id}/realtime-token", (ip) => realtimeToken(from(ip), params({ id: "f1" }))],
  ["divisions/{div}/entrants", (ip) => entrants(from(ip), params(division))],
  ["divisions/{div}/schedule", (ip) => schedule(from(ip), params(division))],
  ["divisions/{div}/stats", (ip) => stats(from(ip), params(division))],
  ["competitions/{slug}/registration", (ip) => registrationInfo(from(ip), params({ orgSlug: "o", slug: "c" }))],
  ["registrations/{id}", (ip) => registrationStatus(withToken(ip), params({ id: REG }))],
  ["registrations/{id}/ics", (ip) => registrationIcs(withToken(ip), params({ id: REG }))],
  ["POST registrations/{id}/checkout", (ip) => checkout(posted(ip), params({ id: REG })), "regcheckout"],
  ["POST registrations/{id}/withdraw", (ip) => withdraw(posted(ip), params({ id: REG }))],
  ["POST registrations/groups/{id}/resend", (ip) => resend(posted(ip), params({ id: REG })), "regresend"],
];

/** Send `n` requests one after another; the statuses, in order. */
async function send(call: Call, ip: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await call(ip)).status);
  return statuses;
}

beforeEach(() => {
  counters.clear();
});

describe("the polled public endpoints: their own per-IP bucket, 300 a minute", () => {
  it.each(POLLED)("%s serves more than 60 from one IP, all 300, and refuses the 301st", async (_route, call) => {
    const statuses = await send(call, "203.0.113.7", 301);
    expect(statuses.slice(0, 300).filter((s) => s !== 200), "the first 300").toEqual([]);
    expect(statuses[300], "the 301st").toBe(429);
  });

  it("all five share ONE poll bucket per IP (one page polling two of them is one budget)", async () => {
    const ip = "203.0.113.8";
    for (const [, call] of POLLED) expect(await send(call, ip, 60)).not.toContain(429);
    expect(counters.get(`rl:pubv1poll:${ip}`)).toBe(300);
    expect((await POLLED[0]![1](ip)).status, "the 301st, across routes").toBe(429);
  });
});

describe("every other public endpoint: still 60 a minute", () => {
  it("premise: NOT_POLLED names all 13 `publicRateLimit` routes, once each", () => {
    expect(NOT_POLLED).toHaveLength(13);
    expect(new Set(NOT_POLLED.map(([route]) => route)).size).toBe(13);
  });

  it.each(NOT_POLLED)("%s serves 60 from one IP, refuses the 61st, and never touches the poll bucket", async (_route, call, own) => {
    const ip = "198.51.100.4";
    const ownKey = own && `rl:${own}:${ip}`;
    const isolated: Call = ownKey
      ? (i) => {
          counters.delete(ownKey);
          return call(i);
        }
      : call;
    const statuses = await send(isolated, ip, 61);
    expect(statuses.slice(0, 60).filter((s) => s !== 200), "the first 60").toEqual([]);
    expect(statuses[60], "the 61st").toBe(429);
    const shared = Object.fromEntries([...counters].filter(([key]) => key !== ownKey));
    expect(shared, "counted in the 60 bucket only").toEqual({ [`rl:pubv1:${ip}`]: 61 });
  });
});

describe("the two buckets are independent, and a request counts against exactly one", () => {
  it("one poll request counts only in the poll bucket; one other request only in the 60 bucket", async () => {
    const ip = "192.0.2.10";
    await hub(from(ip), params({ orgSlug: "o", slug: "c" }));
    expect(Object.fromEntries(counters)).toEqual({ [`rl:pubv1poll:${ip}`]: 1 });
    await standings(from(ip), params({ orgSlug: "o", slug: "c", divisionSlug: "d" }));
    expect(Object.fromEntries(counters)).toEqual({ [`rl:pubv1poll:${ip}`]: 1, [`rl:pubv1:${ip}`]: 1 });
  });

  it("an exhausted 60 bucket still lets the same IP poll", async () => {
    const ip = "192.0.2.11";
    expect((await send(NOT_POLLED[0]![1], ip, 61)).at(-1), "premise: the 60 bucket is exhausted").toBe(429);
    expect(await send(POLLED[2]![1], ip, 100)).not.toContain(429);
  });

  it("an exhausted poll bucket still lets the same IP read everything else", async () => {
    const ip = "192.0.2.12";
    expect((await send(POLLED[2]![1], ip, 301)).at(-1), "premise: the poll bucket is exhausted").toBe(429);
    expect(await send(NOT_POLLED[0]![1], ip, 60)).not.toContain(429);
  });
});

describe("both limiters read the client IP the same way", () => {
  it.each([
    ["the first x-forwarded-for hop", { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" }, "203.0.113.9"],
    ["x-real-ip when there is no x-forwarded-for", { "x-real-ip": "198.51.100.9" }, "198.51.100.9"],
    ["unknown with neither", {}, "unknown"],
  ])("%s", async (_case, headers, ip) => {
    const req = new Request("http://x/", { headers });
    await publicRateLimit(req);
    await publicPollRateLimit(req);
    expect(Object.fromEntries(counters)).toEqual({ [`rl:pubv1:${ip}`]: 1, [`rl:pubv1poll:${ip}`]: 1 });
  });
});
