// Every per-IP limiter that used to read X-Forwarded-For itself now keys on `clientIp` (client-IP hardening, 2026-11-07) -
// driven through the REAL route handlers and page, not a fixture of them. client-ip-readers.test.ts stops a file NAMING the
// headers; this file proves each limiter's bucket is the deployment's client: behind Cloudflare the visitor Cloudflare names
// (never the X-Forwarded-For hop the client wrote, never the edge), and straight to the fly.dev origin Fly's peer (never a
// forged CF-Connecting-IP). Before the change every row here keyed on the forged X-Forwarded-For hop.
//
// Only the limiter's own call is replaced: it records the key, then refuses with the real 429 so nothing behind it runs (no
// body, no DB). The public read budget (`pubv1`) that two routes spend first is let through and checked to key the same way.
// Each limiter's key namespace is typed here from its route - the namespaces are the routes' contract and must not move.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const incoming = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => incoming.headers,
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  const { HttpError } = await import("@/lib/errors");
  return {
    ...actual,
    rateLimit: vi.fn(async (key: string) => {
      if (!key.startsWith("pubv1")) throw new HttpError(429, "Too many requests");
    }),
  };
});

import { rateLimit } from "@/lib/rate-limit";
import RegisterJoinPage from "@/app/(public)/live/[orgSlug]/[competitionSlug]/register/join/page";
import { POST as magicLink } from "@/app/api/auth/magic-link/route";
import { POST as magicLinkConsume } from "@/app/api/auth/magic-link/consume/route";
import { POST as verifyEmail } from "@/app/api/auth/verify-email/route";
import { POST as claimAccept } from "@/app/api/claims/[token]/accept/route";
import { POST as consent } from "@/app/api/consent/route";
import { POST as funnelClaim } from "@/app/api/funnel/claim/route";
import { POST as funnelStart } from "@/app/api/funnel/start/route";
import { POST as inviteClaim } from "@/app/api/invites/[token]/claim/route";
import { POST as formatPreview } from "@/app/api/public/format-preview/route";
import { POST as deviceLinkMint } from "@/app/api/v1/fixtures/[id]/device-links/route";
import { POST as deviceLinkReissue } from "@/app/api/v1/fixtures/[id]/device-links/reissue/route";
import { GET as joinPreview, POST as join } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route";
import { POST as register } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route";
import { POST as checkout } from "@/app/api/v1/public/registrations/[id]/checkout/route";
import { POST as withdraw } from "@/app/api/v1/public/registrations/by-ref/[ref]/withdraw/route";
import { POST as resend } from "@/app/api/v1/public/registrations/groups/[id]/resend/route";

/** A Cloudflare edge (162.158.0.0/15, Cloudflare's published ranges) and one over IPv6 (2606:4700::/32). */
const CF_EDGE = "162.158.12.34";
/** Visitors, as Cloudflare names them. */
const VISITOR = "203.0.113.50";
const VISITOR6 = "2001:db8:1::7";
/** A client reaching the fly.dev origin directly: not Cloudflare. */
const DIRECT = "198.51.100.60";
/** What a client writes into X-Forwarded-For / X-Real-IP itself, to pick a fresh bucket per request. */
const FORGED = "192.0.2.7";

const ID = "00000000-0000-4000-8000-000000000001";
const post = (url: string, headers: Headers) => new Request(`http://x${url}`, { method: "POST", headers });
const get = (url: string, headers: Headers) => new Request(`http://x${url}`, { headers });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

type Row = { name: string; namespace: string; call: (h: Headers) => Promise<unknown>; extra?: Record<string, string> };
const LIMITERS: Row[] = [
  {
    name: "page /live/…/register/join (the preview, sharing the GET route's bucket)",
    namespace: "regjoinpreview",
    call: () =>
      RegisterJoinPage({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c" }), searchParams: Promise.resolve({ join_code: "ABC234" }) }),
  },
  { name: "POST /api/auth/magic-link", namespace: "magic-link", call: (h) => magicLink(post("/api/auth/magic-link", h)) },
  { name: "POST /api/auth/magic-link/consume", namespace: "magic-link-consume", call: (h) => magicLinkConsume(post("/api/auth/magic-link/consume", h)) },
  { name: "POST /api/auth/verify-email", namespace: "verify-email", call: (h) => verifyEmail(post("/api/auth/verify-email", h)) },
  {
    name: "POST /api/claims/[token]/accept (signed out)",
    namespace: "claim-signin",
    call: (h) => claimAccept(post("/api/claims/t/accept", h), ctx({ token: "t" })),
    // Its session-minting branch asks for our own page's request before it counts anything.
    extra: { "sec-fetch-site": "same-origin" },
  },
  { name: "POST /api/consent", namespace: "consent", call: (h) => consent(post("/api/consent", h)) },
  { name: "POST /api/funnel/claim", namespace: "funnel-claim", call: (h) => funnelClaim(post("/api/funnel/claim", h)) },
  { name: "POST /api/funnel/start", namespace: "funnel-start", call: (h) => funnelStart(post("/api/funnel/start", h)) },
  { name: "POST /api/invites/[token]/claim", namespace: "invite-claim", call: (h) => inviteClaim(post("/api/invites/t/claim", h), ctx({ token: "t" })) },
  { name: "POST /api/public/format-preview", namespace: "format-preview", call: (h) => formatPreview(post("/api/public/format-preview", h)) },
  { name: "POST /api/v1/fixtures/[id]/device-links", namespace: "dlmint", call: (h) => deviceLinkMint(post(`/api/v1/fixtures/${ID}/device-links`, h), ctx({ id: ID })) },
  {
    name: "POST /api/v1/fixtures/[id]/device-links/reissue",
    namespace: "dlmint",
    call: (h) => deviceLinkReissue(post(`/api/v1/fixtures/${ID}/device-links/reissue`, h), ctx({ id: ID })),
  },
  {
    name: "GET …/register/join (preview)",
    namespace: "regjoinpreview",
    call: (h) => joinPreview(get("/api/v1/public/orgs/o/competitions/c/register/join?join_code=ABC234", h), ctx({ orgSlug: "o", slug: "c" })),
  },
  { name: "POST …/register/join", namespace: "regjoin", call: (h) => join(post("/api/v1/public/orgs/o/competitions/c/register/join", h), ctx({ orgSlug: "o", slug: "c" })) },
  { name: "POST …/register", namespace: "regsubmit", call: (h) => register(post("/api/v1/public/orgs/o/competitions/c/register", h), ctx({ orgSlug: "o", slug: "c" })) },
  { name: "POST /api/v1/public/registrations/[id]/checkout", namespace: "regcheckout", call: (h) => checkout(post(`/api/v1/public/registrations/${ID}/checkout`, h), ctx({ id: ID })) },
  {
    name: "POST /api/v1/public/registrations/by-ref/[ref]/withdraw",
    namespace: "regwithdraw",
    call: (h) => withdraw(post("/api/v1/public/registrations/by-ref/R1/withdraw", h), ctx({ ref: "R1" })),
  },
  {
    name: "POST /api/v1/public/registrations/groups/[id]/resend",
    namespace: "regresend",
    call: (h) => resend(post(`/api/v1/public/registrations/groups/${ID}/resend`, h), ctx({ id: ID })),
  },
];

/** The deployment's topologies: what the request carries, and the client it must be keyed on. */
const TOPOLOGIES: Array<{ name: string; headers: Record<string, string>; client: string }> = [
  {
    name: "behind Cloudflare: the visitor Cloudflare names, never the X-Forwarded-For hop the client wrote",
    headers: { "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "x-forwarded-for": `${FORGED}, ${VISITOR}`, "x-real-ip": FORGED },
    client: VISITOR,
  },
  {
    name: "behind Cloudflare, a second visitor through the SAME edge: another bucket, never the edge's",
    headers: { "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR6, "x-forwarded-for": `${FORGED}, ${VISITOR6}` },
    client: VISITOR6,
  },
  {
    name: "straight to the fly.dev origin: Fly's peer, never a forged CF-Connecting-IP or X-Forwarded-For",
    headers: { "fly-client-ip": DIRECT, "cf-connecting-ip": VISITOR, "x-forwarded-for": FORGED, "x-real-ip": FORGED },
    client: DIRECT,
  },
];

beforeEach(() => {
  vi.mocked(rateLimit).mockClear();
  // Today's deployment (no origin stamp required) whatever a developer's .env.local holds; client-ip.test.ts owns the stamp.
  vi.stubEnv("CF_ORIGIN_SECRET", undefined);
});
afterEach(() => vi.unstubAllEnvs());

// 18 rows for the 19 IP-keyed buckets in the 17 files: register's second, per-competition bucket (`regsubmit:${ip}:org:slug`,
// behind its honeypot and body) reuses the `ip` its first bucket is proven on here.
it("covers all 18 limiter calls the change moved, in 17 files (anti-vacuity: an emptied table would pass every row below by not running)", () => {
  expect(LIMITERS).toHaveLength(18);
  expect(TOPOLOGIES).toHaveLength(3);
});

describe.each(TOPOLOGIES)("$name", ({ headers, client }) => {
  it.each(LIMITERS)("$name keys $namespace on it", async ({ namespace, call, extra }) => {
    const h = new Headers({ ...headers, ...extra });
    incoming.headers = h; // next/headers' `headers()` is the same request's headers
    const res = await call(h);
    if (res instanceof Response) expect(res.status, "premise: the limiter under test refused it, nothing earlier did").toBe(429);
    const keys = vi.mocked(rateLimit).mock.calls.map(([key]) => key);
    expect(keys.filter((k) => !k.startsWith("pubv1")), "the limiter's own bucket").toEqual([`${namespace}:${client}`]);
    // The public read budget two of these spend first keys on the same client (it already read clientIp).
    for (const k of keys.filter((k) => k.startsWith("pubv1"))) expect(k).toBe(`pubv1:${client}`);
  });
});
