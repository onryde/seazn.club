# Seazn Club

**Run any tournament, for any sport, in any format** — from a 4-player club night to a
multi-season regional league.

Seazn Club is a multi-tenant tournament management SaaS. Organisers create competitions
and divisions, enter live results, and share public standings and schedules. The product
differentiator is a **sport-aware tournament engine** with per-sport scoring fidelity
(cricket innings, football shootouts, volleyball sets, chess Swiss pairing) rather than
generic win/loss brackets.

---

## Repository layout

| Path | Purpose |
|------|---------|
| [`apps/web/`](apps/web/) | Next.js app — UI, API routes, billing, auth, public dashboard |
| `@seazn/engine` | Pure TypeScript tournament engine: the registry package `@onryde/seazn-engine` (GitHub Packages), built in [onryde/seazn.club.engine](https://github.com/onryde/seazn.club.engine) |
| [`engine/`](engine/) | Engine v2 **design corpus** (PROMPT-00–15 landed) — domain model, sport specs, implementation prompts |
| [`development/`](development/) | Product & platform **design docs** — billing, security, realtime, phased plan |
| [`supabase/`](supabase/) | PostgreSQL schema + ordered migrations |
| [`openapi/`](openapi/) | Generated OpenAPI spec for `/api/v1` |
| [`scripts/`](scripts/) | DB bootstrap, engine checks, smoke tests, OpenAPI generation |

This is an npm workspace monorepo. Root scripts delegate to `apps/web`; the engine is
installed from GitHub Packages as `@seazn/engine` (`npm:@onryde/seazn-engine`).

---

## Stack

| Layer | Choice |
|-------|--------|
| App | Next.js App Router, React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL (Supabase) via the `postgres` package — no Supabase client SDK for queries |
| Auth | Emailed magic link and Google sign-in (no passwords); `jose` JWT in httpOnly cookie; active org in a separate cookie |
| Realtime | Supabase Realtime broadcast (live scoreboards) |
| Storage | Supabase Storage (org logos, player avatars) |
| Billing | Stripe (flat per-org pricing) |
| Email | Resend |
| Cache / rate limits | Upstash Redis (optional; falls back to Postgres) |
| Observability | Sentry |

**Hosting (locked):** Vercel or Fly.io for the app, Supabase for Postgres. See
[`development/02-architecture.md`](development/02-architecture.md) for the target topology.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  apps/web — modular monolith                            │
│  Server Components · /api routes · webhooks · public UI │
└──────────────────────────┬──────────────────────────────┘
                           │ imports (pure logic only)
┌──────────────────────────▼──────────────────────────────┐
│  @seazn/engine — zero I/O, event-sourced, deterministic  │
│  SportModule plugins · Competition engine · Scheduling  │
└──────────────────────────┬──────────────────────────────┘
                           │ events + snapshots persisted
┌──────────────────────────▼──────────────────────────────┐
│  PostgreSQL (Supabase) — RLS, billing, audit hash-chain   │
└───────────────────────────────────────────────────────────┘
```

**Two engines, one contract** (see [`engine/03-engine-architecture.md`](engine/03-engine-architecture.md)):

1. **Match Engine** — per-sport `SportModule` plugins own fixture scoring: event
   vocabulary, live state, validity, outcome.
2. **Competition Engine** — sport-agnostic core owns progression: stage graphs, fixture
   generation, standings, tiebreaker cascades.

The DB adapter persists events and derived snapshots; business rules never live in SQL.

### Engine modules (implemented)

| Module | Sports |
|--------|--------|
| `boardgame` | Chess, generic 1v1 |
| `setbased` | Volleyball, badminton, table tennis |
| `football` | Association football |
| `cricket` | T20 / ODI / 100-ball variants, NRR, DLS hook |
| `generic` | Fallback win/loss scoring |

Scheduling: round-robin (circle method), Swiss pairing, brackets, calendar slotting.
Conformance tests live in the engine repo's `src/testkit/`, shipped as `@seazn/engine/testkit`.

The [`engine/`](engine/) folder holds the full greenfield design — sport deep-dives,
greenfield schema, API design, entitlements matrix, and ordered
[`engine/prompts/`](engine/prompts/) for incremental implementation. Most prompts are landed
in the engine (now onryde/seazn.club.engine) and `apps/web`; each design wave under [`design/`](design/) ships as
an ordered `PROMPT-*` batch (see status table below for per-wave status).

---

## Implementation status

Design corpus lives in [`design/`](design/) as ordered `PROMPT-*` waves. Waves v2, v3, v5,
v6–v13 are complete and merged to `main`. v4, v14 and v15 are designed, not yet built.

| Wave | Prompts | Focus | Status |
|------|---------|-------|--------|
| v2 | 00–29 | Engine v2 build-out + Jul3 batch (modules, scheduling, tier-1) | ✅ Complete |
| v3 | 30–40 | Routing, UI system, mobile, pricing v3, marketing redesign | ✅ Complete |
| v4 | 41–43 | AI schedule engine, refine/repair, board UX | ⬜ Pending |
| v5 | 44–47 | i18n foundation (en/fr/es/nl); modernized across app + score pads | ✅ Complete |
| v6 | 48–50 | Tennis, ice hockey, field hockey modules + pads | ✅ Complete |
| v7 | 51–52 | Platform revenue report, registration settings redesign | ✅ Complete |
| v8 | 53–54 | Player accounts, DB connection budget | ✅ Complete |
| v9 | 55 | Dispute / loss recovery | ✅ Complete |
| v10 | 56 | Sponsor CRM + monetization | ✅ Complete |
| v11 | 57 | Official onboarding | ✅ Complete |
| v12 | 58 | Scheduling docs + doc branding | ✅ Complete |
| v13 | 59–66 | Competition fidelity, bulk enrol, brackets, audit export, ad-hoc fixtures | ✅ Complete |
| v14 | 67 | Visual flow help pages | ⬜ Pending |
| v15 | 68–71 | Venue library + multi-venue scheduling | ⬜ Pending |

---

## Getting started

### Prerequisites

- Node.js 22+
- PostgreSQL (local or Supabase project)

### Install

```bash
npm ci
```

### Environment

One env file, and it lives at the repo root. `apps/web/.env.local` is a **symlink** to it,
so the dev server, the `db:*` scripts and vitest all read the same values. Both paths are
gitignored, so recreate the symlink in every fresh clone or worktree:

```bash
cp apps/web/.env.example .env.local
ln -sf ../../.env.local apps/web/.env.local
```

Required for local dev:

- `DATABASE_URL` — Supabase transaction pooler (port 6543) or local Postgres
- `AUTH_SECRET` — `openssl rand -hex 32`

Optional but needed for full feature coverage: Supabase keys (realtime, storage), Stripe
(test keys), Resend, Google OAuth. See [`apps/web/.env.example`](apps/web/.env.example)
for the full list.

Emergency lever, default off: `ENGINE_EPOCH_FLOOR_OVERRIDE=football=2,hockey=1` lowers the scoring door's per-sport engine-epoch
floor (the 426 `ENGINE_OUTDATED` gate) so capture apps one epoch behind can keep scoring after a bump. It only ever lowers a
floor, treats a value it does not understand as off (logged as an error and reported to Sentry; the boot carries on), and logs
loudly; see the root [`.env.example`](.env.example).

### Cloudflare Stream (relay tier)

The streaming programme's Tier B relay publishes a phone's feed into a Cloudflare Stream
live input, pulls it back into a headless browser, and re-encodes to the club's
destination. It is wired behind `RELAY_DRIVERS`
([`apps/web/src/server/relay/drivers.ts`](apps/web/src/server/relay/drivers.ts)): unset,
empty or `fake` runs in-memory Cloudflare and Fly doubles with no network — every local
run and every test — and `live` calls the real APIs. In a production build
(`NODE_ENV=production`) an unset `RELAY_DRIVERS` is **disabled** instead: no drivers, and
every stream start answers `503 ingest_unavailable`; production-build harnesses (CI's
server steps, `scripts/ci-local.sh`) set `RELAY_DRIVERS=fake` explicitly. An explicit
`fake` is allowed only with `ENV_NAME` unset, `local` or `ci` — on `stg`/`prod` the server
refuses to boot. Live mode needs an account and a Stream-scoped token:

- `CLOUDFLARE_ACCOUNT_ID` — the account live inputs are created under
- `CLOUDFLARE_STREAM_TOKEN` — scoped to Stream; server-side only, never a `NEXT_PUBLIC_*` var, never reaches the browser

`RELAY_KEK` is required in both modes (it seals every stored stream key). Live mode also
refuses without `ENV_NAME`, and live composed streams need `FLY_API_TOKEN`,
`FLY_RELAY_APP` and `RELAY_IMAGE`. These refusals are LAZY: each fires at the first relay
call that needs the value (a composed start's Machine, the daily sweep), not at boot — a
deploy missing one starts and serves until then. The relay block of the root
[`.env.example`](.env.example) documents each one.

**Deploy step — sponsors on stream (R4).** Sponsor airings and proof frames stay off until
web's `RELAY_AIRINGS=1`, which web copies into every composed Machine's env
(`server/relay/runner-fly.ts`). Set it as a Fly secret on the **web** app only after, in this
order: R4 PR A (web) is deployed; the **private** Supabase Storage bucket `sponsor-frames`
exists; and the compositor carrying R4 PR C is deployed and named by `RELAY_IMAGE`. Before
that, leave it unset — a Machine without it sends no airings and grabs no frames, so the
report's "Times shown" stays 0. Streams already running keep the env they booted with.

**Rollback step.** Before rolling web back past R4 PR A, unset `RELAY_AIRINGS` on web and let the composed streams
running with it end. An older web refuses a beat that carries airings. The compositor turns airings off after one refused
count-only beat, but when airing lines arrive first it takes the second refused beat: about 10 s at the 5 s cadence,
close to web's 15 s composed stale window.

**Deploy step — client IP behind Cloudflare (`CF_ORIGIN_SECRET`).** Every per-IP rate limit keys on
[`apps/web/src/lib/client-ip.ts`](apps/web/src/lib/client-ip.ts), which believes Cloudflare's `CF-Connecting-IP` only
when Fly's peer is a Cloudflare edge. Anyone with a Cloudflare zone of their own can still reach the `*.fly.dev` origin
through Cloudflare's network and set that header to anything. The close is an origin stamp: our zone writes a secret
header, `x-seazn-origin-secret`, and web believes `CF-Connecting-IP` only on a request that carries it. **The order
matters:**

0. **The web release that carries the Sentry scrub must be live on that app first.** From the moment the rule exists,
   every request carries the secret, and an earlier web release does not redact it from the events it sends to Sentry.
1. In Cloudflare, add a **Rules → Transform Rules → Modify Request Header** rule: *Set static*, header
   `x-seazn-origin-secret`, value a fresh random secret of 32+ bytes (`openssl rand -hex 32`), with a **different value
   per environment**. `stg.seazn.club` sits under the `seazn.club` zone unless stg has a zone of its own, so this is one
   rule per Fly app. Its filter is an **exact** host list of the hostnames that app serves (`fly certs list -a
   seazn-club-prod` and `-a seazn-club-stg` list them, `games.` hosts included), with PostHog's proxy path left out:

   ```
   (http.host in {"seazn.club" "www.seazn.club" "games.seazn.club"})
     and not (http.request.uri.path eq "/ingest" or starts_with(http.request.uri.path, "/ingest/"))
   ```

   (Use the hosts `fly certs list` prints, not the three above.) **Never `ends_with` or `contains` on the host.** The
   stamp goes to whatever origin serves a matched host. `ends_with(http.host, "seazn.club")` also matches
   `stg.seazn.club`, so prod's secret would be stamped onto stg's requests, and stg would mismatch on every one of
   them. `contains` would also match any future host in the zone that points at another vendor, and would hand that
   vendor the secret. **`/ingest/*` is excluded** because `apps/web/next.config.js` rewrites `/ingest/:path*` to
   PostHog's ingest and asset hosts. A rewrite to an external host forwards the request's headers, so a stamped
   `/ingest` request would carry the secret to PostHog. Those paths never reach a rate limiter, so an unstamped one
   costs nothing. Before going on, confirm with Cloudflare Trace that the rule matches each host and skips `/ingest/x`.
2. Only **then** set the matching value on that web app: `fly secrets set CF_ORIGIN_SECRET=<value> -a seazn-club-stg`
   (stg first), then `-a seazn-club-prod`. If the secret is set before the rule exists, its value differs from the
   rule's, or a host is missing from the filter, those requests carry no matching stamp. They fall back to
   `Fly-Client-IP`, which is a Cloudflare edge, so every visitor behind that edge shares one rate-limit bucket.
   **Sign-in is the first casualty:** `magic-link` (5 per 5 minutes) and `magic-link-consume`, `verify-email`,
   `claim-signin`, `invite-claim` and `funnel-claim` (10 a minute each) are then counted per Cloudflare colo, not per
   visitor.
   Nothing is ever refused for a missing stamp; requests only lose their per-visitor bucket. A mismatch is not silent:
   web logs a warning with the reason `origin_stamp_mismatch` at most once a minute per machine, and sends one
   `origin_stamp_mismatch` warning to Sentry per process. Neither carries the header's value or the secret.
3. **After setting it, check it.** Sign in from two different networks (say, office wifi and a phone on mobile data).
   Both must succeed, `fly logs -a <app>` must show no `origin_stamp_mismatch`, and Sentry must have no
   `origin_stamp_mismatch` issue for that environment. If either shows up, unset the secret (rollback, below) before
   finding the host or value at fault.

**Rotation:** (1) `fly secrets unset CF_ORIGIN_SECRET -a <app>`; (2) change the rule's value in Cloudflare to the new
secret and confirm with Trace; (3) `fly secrets set CF_ORIGIN_SECRET=<new value> -a <app>`; (4) repeat the step 3 check.
**Between (1) and (3), web runs on range trust alone**, as it did before the stamp existed. During that window, a
`CF-Connecting-IP` forged through another Cloudflare zone is believed again. Keep it short, and do not rotate while
someone is working that gap. Never change the rule first: from then until the secret is set, every request mismatches.

**Rollback:** unset the Fly secret first (`fly secrets unset CF_ORIGIN_SECRET -a <app>`), then remove the rule. Rolling
web back **past the release that carries the scrub** additionally requires the rule to be removed first, for the same
reason step 0 exists.

Unset, web behaves exactly as it did before the stamp existed, and no mismatch is reported. The value is never logged
or echoed. It stays out of Sentry in two ways, and both are needed:

- **The SDK masks it.** `@sentry/nextjs` copies every incoming header onto the root span as an
  `http.request.header.<name>` attribute. The header's name carries `secret`, which is on the SDK's own deny list, so
  that attribute reads `[Filtered]`. The earlier name, `x-seazn-origin`, was not on that list, and its value reached
  Sentry in clear in the trace data.
- **Our scrub redacts it.** `lib/scrub-score-url.ts` rewrites it to `[redacted]` in `request.headers`, in the trace
  context's data and in every span's data, on errors and transactions alike.

Do not rename the header without keeping both. An alternative is Cloudflare's **Authenticated Origin Pulls** (mTLS from
Cloudflare to the origin). The zone-level variant presents Cloudflare's shared certificate, which proves "Cloudflare"
rather than "our zone", so only a certificate of our own would do. Fly's proxy terminates TLS before web sees the
request, so that option was not evaluated here.

Two facts worth knowing before reading the design:

- `stream.liveInputs.create()` returns `{ uid, rtmps, srt, webRTC }` from a single call,
  so both ingest credential shapes are in hand without a second request. That is why the
  QR contract carries both rather than choosing one at provision time.
- `timeoutSeconds` is nested under `recording` and governs when a disconnect starts a new
  recorded video. It does **not** describe what a playback connection sees while an input
  is disconnected — that is the open question the U1 spike exists to settle, and the
  composited tier's "the encoder never restarts" property rests on the answer.

**Measured behaviour of this API — read before writing against it:**
[`docs/superpowers/specs/2026-09-11-cloudflare-stream-measured.md`](docs/superpowers/specs/2026-09-11-cloudflare-stream-measured.md).
Nine findings taken first-hand against the live API, four of which contradicted
the design and three of which would have shipped green: settings accepted with a
200 and silently ignored, a healthy manifest that 403s a non-browser client, and
recordings that keep billing after their live input is deleted.

For any Cloudflare work, load the `cloudflare` skill rather than working from memory:
limits and API shapes move, and the skill retrieves current docs.

### Database

Apply schema and migrations (local dev or CI bootstrap):

```bash
npm run db:apply
```

> **Warning:** `scripts/apply-schema.ts` drops data — use only on empty local databases.
> Production/staging should run migrations incrementally.

Sync the sport catalog from the engine registry after schema apply:

```bash
npm run sync:sports
```

### Run

```bash
npm run dev        # Next.js dev server at http://localhost:3000
npm run build      # production build
npm run start      # serve production build
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the web app in development |
| `npm test` | Vitest in `apps/web` |
| `npm run test:smoke` | End-to-end HTTP smoke test (needs running server + DB) |
| `node --experimental-strip-types scripts/migrate-v1-to-v2.ts --dry-run` | v1→v2 data migration (idempotent; see script header) |
| `npm run db:apply` | Apply `schema.sql`, migrations, and `schema_v2.sql` |
| `npm run sync:sports` | Sync sport catalog from engine registry to DB |
| `npm run openapi:gen` | Regenerate `openapi/v1.json` |
| `npm run check:rls` | Fail if any `org_id` table lacks an RLS policy |

---

## Testing & CI

CI (`.github/workflows/ci.yml`) runs on every push and PR:

1. **Unit + typecheck** — TypeScript, engine checks, OpenAPI drift gate, Vitest
2. **Security** — gitleaks secret scan, `npm audit` (advisory)
3. **Smoke** — Postgres container → `db:apply` → RLS check → integration tests → dev
   server → HTTP smoke test

Integration tests under `apps/web/src/server/` and `apps/web/src/lib/__tests__/` require
`DATABASE_URL`. `apps/web/vitest.config.ts` loads the root `.env.local`, so a bare
`npx vitest run` picks it up; without a `.env.local` (CI) the vars must come from the
environment, or ~700 tests skip and the run still reports green. The **Smoke** job runs
both directories against a real Postgres.

The smoke test needs `DATABASE_URL` (DB-backed suites skip silently without it). Stripe
Connect destination charges — sponsor-package checkout **and** registration entry-fee
checkout (RS006) — additionally need `STRIPE_CONNECT_TEST_ACCOUNT`: a *real* test-mode
connected account id with charges enabled, since smoke's fabricated `acct_smoke_*` id is
rejected by Stripe. Without it those assertions are skipped, not failed, and the check
count is unchanged. `npm run stripe:connect-fixture` creates the account (idempotent —
re-running with a healthy account already set just verifies it and exits); a fresh
Express account still needs Stripe's own hosted onboarding completed once by hand
(test-mode data — see the script's own header for why this can't run headless), after
which the id it prints is durable. See [`apps/web/.env.example`](apps/web/.env.example).

---

## Documentation

### Product & platform — [`development/`](development/)

Detailed technical designs for turning the app into a paid, enterprise-grade SaaS.
Start with the [development README](development/README.md) and the
[Phase 0/1 build checklist](development/00-phase-0-1-build-checklist.md).

| Theme | Entry point |
|-------|-------------|
| Product strategy & tiers | [01-product-strategy.md](development/01-product-strategy.md) |
| System architecture | [02-architecture.md](development/02-architecture.md) |
| Multi-tenancy & RLS | [03-multi-tenancy-data-model.md](development/03-multi-tenancy-data-model.md) |
| Security & compliance | [04-security-compliance.md](development/04-security-compliance.md) |
| Stripe billing & entitlements | [05-payments-billing.md](development/05-payments-billing.md) |
| Supabase Realtime | [10-supabase-realtime.md](development/10-supabase-realtime.md) |
| Engine quality & CI gates | [12-quality-and-engine-correctness.md](development/12-quality-and-engine-correctness.md) |
| Deferred work tracker | [DEFERRED.md](development/DEFERRED.md) |

### Tournament engine — [`engine/`](engine/)

Greenfield design for Engine v2. Start with the [engine README](engine/README.md).

| Theme | Entry point |
|-------|-------------|
| Strategy & principles | [01-strategy.md](engine/01-strategy.md) |
| Domain model | [02-domain-model.md](engine/02-domain-model.md) |
| Package layout & SportModule contract | [03-engine-architecture.md](engine/03-engine-architecture.md) |
| Per-sport scoring specs | [04-sport-scoring-specs.md](engine/04-sport-scoring-specs.md) |
| Formats, tiebreakers, scheduling | [05-formats-progression-tiebreakers.md](engine/05-formats-progression-tiebreakers.md) |
| Greenfield DB schema | [07-greenfield-schema.md](engine/07-greenfield-schema.md) |
| Versioned API (`/api/v1`) | [08-api-design.md](engine/08-api-design.md) |
| Implementation prompts (ordered) | [engine/prompts/](engine/prompts/) |

---

## Conventions

These apply across app and engine code:

- **Types first** — Zod schema + inferred type before behaviour
- **Thin API routes** — parse → authorize → delegate to a server-only module; wrap in `handler()`
- **Pure vs effectful** — tournament math in `@seazn/engine` or pure lib modules; DB and side effects in transactional server modules (`import "server-only"`)
- **Entitlement gate** — all paid capability checks go through one helper, enforced server-side and reflected in UI
- **Engine boundary** — no `postgres`, `fetch`, `Date.now()`, or `Math.random()` inside the engine (onryde/seazn.club.engine)

---

## Product tiers (summary)

| Tier | Target | Highlights |
|------|--------|------------|
| Community | Hobbyists, small clubs | Free; limited tournaments/players |
| Pro | Clubs & academies (beachhead) | Unlimited events, branding, public pages, realtime |
| Business | Multi-venue operators | API, analytics, multiple admins |
| Enterprise | Federations, districts | SSO/SCIM, audit export, SLA (coming soon) |

Full entitlement matrix: [`development/01-product-strategy.md`](development/01-product-strategy.md)
and [`engine/10-pro-entitlements.md`](engine/10-pro-entitlements.md).
