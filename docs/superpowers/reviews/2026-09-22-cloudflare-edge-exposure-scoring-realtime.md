# Cloudflare edge exposure — scoring and realtime paths

**Date:** 2026-09-22
**Trigger:** owner adopted Cloudflare in front of the app (2026-09-22),
superseding the 2026-09-20 "not now". Owner asked: make sure Cloudflare does
not impact scoring or realtime.
**Status:** findings only. Nothing fixed. Not part of the W1 device-link
write-path wave; recorded separately so the wave's scope stays honest.

## The distinction that matters

A Cloudflare **cache rule** is invisible and untestable from a working
session — nobody here can see the dashboard, and no test can pin it. A
**response header emitted by the route** is in the repo, is reviewable, and
can be pinned by a test. Where a route defends itself, a misordered cache
rule cannot hurt it. Where it does not, safety rests entirely on a dashboard
rule being present and correctly ordered.

Today, **no route on the scoring or realtime path defends itself.**

## Findings

### F-CF1 — realtime token: cache-based authorisation bypass (latent)

`apps/web/src/app/api/v1/public/fixtures/[id]/realtime-token/route.ts:18-29`

- `GET`, on a `/api/v1/public/**` path.
- `:22-26` is a pure authorisation gate: `fixtureRealtimeEligible(id)` ∥
  `isFixtureOfficial(id)` ∥ `isFixtureDeviceLink(req, id)`, else `403`.
- `:27-28` returns `{ token, channel }`. `lib/realtime.ts:232-248` mints the
  token per **fixture** (`sub: "public:"+fixtureId`, ttl 3600) — so the body
  is byte-identical for every authorised caller.
- **No `Cache-Control`, no `CDN-Cache-Control`, no `Vary: Authorization`,
  no `export const dynamic`.**

The response varies by the `Authorization` header and says so nowhere. Cache
one authorised 200 at an edge and the next anonymous caller — who the gate
would have refused with 403 — is served a valid subscriber token for
`fixture:{id}`, including for a private competition.

Correcting a plausible misreading: the risk is NOT that devices share a
token. They already do, by design. The risk is that a cached 200 **bypasses
the 403**.

**Latent, not live.** Cloudflare does not cache JSON at extensionless paths
without a cache rule (docs-verified 2026-09-14, recorded in the Cloudflare
memory). So this needs someone to add an "Eligible for cache"/Cache
Everything rule, or to misorder the `/api/` bypass rule — which must sit
LAST, because the last matching rule wins. It is one dashboard toggle from
live, and the repo asserts nothing against it.

### F-CF2 — `GET .../state`: ETag with no Cache-Control

`apps/web/src/app/api/v1/fixtures/[id]/state/route.ts:15` sets an `ETag` and
no `Cache-Control`. This is the worst-shaped of the three: a validator with
no freshness directive invites **heuristic caching**, where an intermediary
picks its own TTL. Live scores served from a guessed TTL.

### F-CF3 — poll fallback can be edge-cached

`use-fixture-stream.ts:21,152` → `use-pad-pipeline.ts:1152` →
`transport.ts:315-316` → `GET /api/v1/fixtures/{id}/events?since_seq=N`
(`events/route.ts:21`). No cache headers. This is the 15s fallback a pad
uses when realtime is unavailable — precisely the path a Community-plan
scorer depends on. An edge-cached response is stale scores on a live pad,
and the client's own `no-store` would not help, because the edge copy is
upstream of the browser.

### F-CF4 — no central cache policy for `/api/*`

- No tracked `middleware.ts` (only `.next/` build artifacts).
- `next.config.js:5-25` `headers()` sets security headers only — no cache key.
- `api-v1/http.ts:143-150` / `api-v1/context.ts:30`: `v1()` attaches only
  `rateLimitHeaders()`.

Every route sets its own, across ~22 sites. Two are deliberately cached and
must stay that way: `public.ts:68` (`public, s-maxage=30,
stale-while-revalidate=300`) and `public/fixtures/[id]/route.ts:14`
(`public, s-maxage=2, stale-while-revalidate=30`, whose `:7-14` comment
records that a prior `private, no-store` was reverted on purpose).

### F-CF5 — the app does not know it is behind Cloudflare

`CF-Connecting-IP`, `CF-Ray`, `CF-IPCountry`: **not found anywhere** in
`apps/web/src`, `apps/web/e2e`, `next.config.js`, `packages`, `scripts`.

`publicRateLimit` derives client IP at `server/usecases/public.ts:73` as
`x-forwarded-for`[0] ?? `x-real-ip` ?? `"unknown"`. Cloudflare does preserve
the client IP there, so the limiter keeps working — but a directly reachable
origin lets anyone forge that header and walk past it. That hole predates
Cloudflare; Cloudflare is what makes it closable (`CF-Connecting-IP` plus an
origin locked to Cloudflare ranges).

### F-CF6 — confirmed: `Retry-After` can only come from the edge

`grep -rnai retry-after apps/web/src/server/api-v1/` → no matches. The only
`src/server` hits are `relay/fly-client.ts:249` (reads Fly's, outbound) and a
comment at `usecases/pass-credit.ts:344`.

So any `Retry-After` reaching a scoring pad in production is set by the edge,
not by us. This is why `scorepad/pipeline.ts`'s `THROTTLE_SERVER_MAX_MS`
(60s) bound exists: obey a server instruction generously, but never let a
header we do not own park a courtside queue indefinitely.

### F-CF7 — the realtime websocket does NOT traverse our zone

`lib/supabase-browser.ts:10-13` via `use-fixture-stream.ts:52-57`:
`createClient(NEXT_PUBLIC_SUPABASE_URL, …)` then `sb.realtime.setAuth(token)`.
The socket connects to `*.supabase.co` directly. Server-side broadcast also
goes direct (`lib/realtime.ts:42,77`).

**So Cloudflare cannot affect the realtime transport itself.** The edge risk
is entirely on the HTTP token that gates it (F-CF1), not the socket.

### Not at risk

The scoring WRITE path. `scorepad/transport.ts:278-279` →
`POST /api/v1/fixtures/{id}/events` (`events/route.ts:11`). A POST is not
cacheable by default. Method-protected only — the repo asserts nothing — but
no realistic cache rule makes a POST cacheable.

## Recommendation

Two tiers, deliberately separated by blast radius.

**Narrow, do now:** `Cache-Control: no-store` plus `Vary: Authorization` on
the three GETs in F-CF1/F-CF2/F-CF3, with a test pinning each. Three route
handlers, no shared helper touched, no behaviour change for any correct
caller. This removes the dependency on a dashboard rule entirely for the
paths that matter most.

**Wider, needs a decision:** a default `no-store` for `/api/v1/**` in the
`v1()` wrapper, with the two deliberately-cached public routes opting out
explicitly. This is the durable answer — it makes the safe case the default
and forces a route to say when it wants caching — but it touches every API
response in the app and inverts a current convention, so it wants its own
review rather than riding along inside this wave.

Separately, and independent of caching: adopt `CF-Connecting-IP` for client
IP derivation and lock the origin to Cloudflare ranges (F-CF5). That closes
a header-forgery hole that exists today.
