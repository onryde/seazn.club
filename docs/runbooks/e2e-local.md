# Running the Playwright e2e suite locally

The suite drives a **pre-compiled production server that you start yourself**.
`playwright.config.ts` has no `webServer` block on purpose (#342) — a config that
built and served the app for you is what produced runs that reported green while
testing a broken server. Instead, `e2e/global-setup.ts` inspects whatever is on
`PLAYWRIGHT_BASE` before a single spec runs and aborts with the fix if it is not
a healthy build of this app.

---

## 1. A database

Any migrated Postgres will do; it will accumulate `TAG`-prefixed e2e users and
orgs, so use a disposable one, never your dev DB if you care about its contents.

```bash
npm run db:apply        # Flyway migrate
npm run sync:sports     # sport catalog from the engine registry
```

## 2. Build

```bash
rm -rf apps/web/.next                      # see "Stale .next" below
NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 npm run build --workspace apps/web
```

`NEXT_PUBLIC_SCOREPAD_HOLD_MS` is what CI sets, and it belongs on the BUILD
command specifically: the v3 scoring pad soft-commits every tap — the event is
queued at once but not SENT for `queue.ts`'s `HOLD_MS` — and a spec that polls
the ledger waits that window out once per tap. Shipped is 12s, which is a
product decision about the attribution dock being readable on a phone; the
walkthrough specs tap whole matches (sixteen rallies for badminton, twenty-one
for table tennis) and run for minutes at that window.

Two things about it are easy to get wrong:

- It is a `NEXT_PUBLIC_*` var, so it is substituted into the client bundle at
  BUILD time. Exporting it only in the shell you run Playwright from changes
  the specs' derived waits and NOT the pad's actual window — the specs would
  then be racing a window the browser is not using. Set it on the build, and
  export it for the test run too (CI sets it once at job level, which covers
  both).
- Omitting it entirely is safe, just slower: `resolveHoldMs` falls back to the
  shipped 12s and every affected spec derives its own timeout from `HOLD_MS`,
  so nothing goes red — the run simply takes several minutes longer.

## 3. Stage the static tree into the standalone output

`next.config.js` sets `output: "standalone"`. The standalone output copies
`public/` for you, but **not** `.next/static` — a server booted without it
answers `/api/health` and page HTML with 200 while every `/_next/static/*.js`
chunk 404s. The app renders and then does nothing, and specs fail one by one on
clicks and navigations as if the product were broken.

```bash
rm -rf apps/web/.next/standalone/apps/web/.next/static
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
```

The `rm -rf` first is not optional: BSD `cp -R src dst` when `dst` already
exists copies *into* it, so a second run silently produces
`.next/static/static/…`.

Note the path: `outputFileTracingRoot` points at the monorepo root, so the
server lands at `.next/standalone/**apps/web/**/server.js`, not the
`.next/standalone/server.js` that Next's own warning text names.

Unlike CI (and the production image), a local server does **not** overlay the
compiled `.next/server` over this tree, so `instrumentation.ts`'s `register()` does
not run on it: no Sentry init, no relay boot check, no public-error `no-store`
guard. That is deliberate: a local build inlines your dev `NEXT_PUBLIC_SENTRY_DSN`,
and an overlaid server would start reporting to that project.

## 4. Start the server

**`npm run start` (`next start`) is wrong here.** It does not serve a standalone
build — it prints

```
⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.
```

and serves the non-standalone tree, i.e. not what production runs.

```bash
cd apps/web
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/your_e2e_db" \
DATABASE_SSL=disable \
AUTH_SECRET=e2e-local-secret \
E2E_PROD_TARGET=1 \
NODE_ENV=production \
PORT=3100 \
NEXT_PUBLIC_SUPABASE_URL="https://stub.supabase.co" \
SCHEDULING_AI_BASE_URL=http://127.0.0.1:4319 \
ANTHROPIC_API_KEY=sk-ant-e2e-fixture \
STRIPE_SECRET_KEY=sk_test_ci_e2e_dummy \
STRIPE_WEBHOOK_SECRET=whsec_e2e_payments \
LICHESS_BASE_URL=http://127.0.0.1:4321 \
REALTIMEKIT_BASE_URL=http://127.0.0.1:4322 \
CLOUDFLARE_ACCOUNT_ID=e2e-rtk-account \
REALTIMEKIT_API_TOKEN=e2e-rtk-api-token \
REALTIMEKIT_APP_ID=e2e-rtk-app \
REALTIMEKIT_PLAYER_PRESET=e2e_chess_player \
REALTIMEKIT_ARBITER_PRESET=e2e_chess_arbiter \
LICHESS_TOKEN_KEK=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
CRON_SECRET=e2e-local-cron-secret \
  node .next/standalone/apps/web/server.js
```

### The env vars, and why

| Var | Why |
| --- | --- |
| `DATABASE_URL` | Same DB the runner's SQL helpers use. If the server and the runner point at different databases, logins mint on one and are consumed on the other. |
| `AUTH_SECRET` | **Required.** Under `NODE_ENV=production` a server without it cannot sign a session: consuming a real login token returns `{"ok":false,"error":"AUTH_SECRET environment variable is required in production"}` and every login in the suite fails. |
| `E2E_PROD_TARGET=1` | A production build never dev-exposes `login_url`, so the auth helpers mint login tokens straight in the DB. Set it for the runner too. |
| `RESEND_API_KEY` | **Must be UNSET or blank.** The recipe above does not load `.env.local`, so this is already true — but a server started any other way (`seazn-env.sh`, or a hand-rolled `--env-file=<main>/apps/web/.env.local`) picks up a LIVE key, and every login in the suite then makes a real Resend API call. `lib/email.ts`'s `send()` short-circuits on a falsy key and returns `false`, which is the configuration four specs assert against (`officials-directory`, `directory-officials-roles`, `directory-player-identity`, `scheduling-officials-handoff` all read the claim link out of the DB precisely because the send failed). Process env beats an `--env-file` entry, so `RESEND_API_KEY=` on the command line is enough to blank one the file supplies. |
| `REDIS_URL` | **Must be UNSET.** With Redis reachable the magic-link limiter (5 per 5 min, fail-closed) stops being inert and throttles the suite's own logins. CI omits Redis deliberately. |
| `NEXT_PUBLIC_SUPABASE_URL` | A stub, not empty: `publicStorageUrl("")` hides every badge/crest and makes logo assertions untestable. |
| `SCHEDULING_AI_BASE_URL`, `ANTHROPIC_API_KEY` | `ai-architect.spec.ts` starts a model fixture server on `AI_FIXTURE_PORT` (4319); the app must point at it and carry a non-empty key so the ai-plan routes never 503. These used to be injected by the old `webServer.env` block, which only ever applied to a server Playwright started itself. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Only for `payments-hardening.spec.ts`, which posts signed synthetic webhooks at the real route. CI dummies; no real Stripe call is made. |
| `LICHESS_BASE_URL`, `REALTIMEKIT_BASE_URL` | The online-chess walkthrough (`walkthrough/chess-external-play.spec.ts`) starts a Lichess fixture server on 4321 and a RealtimeKit one on 4322 (`e2e/lichess-fixture-server.ts`, `e2e/realtimekit-fixture-server.ts`); the server must point at both. **An unset `LICHESS_BASE_URL` means the server calls lichess.org for real** (and an unset `REALTIMEKIT_BASE_URL`, Cloudflare), with the suite's fake tokens. The spec's first assertion of each names these variables when its fixture sees no traffic. |
| `CLOUDFLARE_ACCOUNT_ID`, `REALTIMEKIT_API_TOKEN`, `REALTIMEKIT_APP_ID`, `REALTIMEKIT_PLAYER_PRESET`, `REALTIMEKIT_ARBITER_PRESET` | The video fixture's own credentials (`REALTIMEKIT_FIXTURE_ENV`; anything else is refused 401 / routed nowhere). Without all five the server never calls video at all ("unconfigured"), and the walkthrough's camera states cannot be reached. |
| `LICHESS_TOKEN_KEK`, `CRON_SECRET` | The chess walkthrough seals each player's Lichess token and fires the external-play sweep itself, so the RUNNER needs the server's values too (step 5 carries them): the CI ones are in `scripts/ci-local.sh`'s `common_env` and e2e.yml (`CRON_SECRET` in e2e.yml only). `AUTH_SECRET` likewise: the runner mints the players' room links, and refuses to mint without it. A KEK that differs between the two is not an environment red the spec can name for you: the server cannot open the sealed tokens, never calls the Lichess fixture, and the walkthrough's poll then prints the bridge row's `last_error`. |

`NEXT_PUBLIC_*` values are baked at **build** time — set them for step 2 as well
as step 4.

## 5. Run the suite

```bash
cd apps/web
DATABASE_URL="…" DATABASE_SSL=disable E2E_PROD_TARGET=1 \
AUTH_SECRET=e2e-local-secret \
LICHESS_TOKEN_KEK=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
CRON_SECRET=e2e-local-cron-secret \
PLAYWRIGHT_BASE=http://localhost:3100 \
  npm run test:e2e            # parallel, then serial --workers=1, then both mobile projects
```

The three secrets are the SERVER's (step 4), byte for byte: the runner signs
room links, seals Lichess tokens and fires the sweep with them.

Single spec / project:

```bash
PLAYWRIGHT_BASE=http://localhost:3100 npx playwright test --project=parallel marketing-home.spec.ts
PLAYWRIGHT_BASE=http://localhost:3100 npx playwright test --project=mobile-se
```

`PLAYWRIGHT_BASE` defaults to `http://localhost:3000`, so it is required
whenever your server is on another port.

---

## What the preflight rejects

`e2e/global-setup.ts` runs once, before every project (including `setup`, which
is what spends the login budget). Each check aborts the run with the resolved
base URL and the recipe:

| Symptom | Meaning |
| --- | --- |
| `REDIS_URL is set in this shell` | `unset REDIS_URL`. |
| `no server answering at …/api/health` | Nothing listening, or wrong `PLAYWRIGHT_BASE`. |
| `not healthy — /api/health returned 503 {"ok":false,"db":"down"}` | Server is up but cannot reach `DATABASE_URL`. |
| `renders HTML but does not serve its own JavaScript` | Step 3 was skipped, or you served with `next start`. |
| `/api/auth/magic-link/consume answered 404` | The build being served is not this app (stale or partial). |
| `the server … has no AUTH_SECRET` | Step 4's `AUTH_SECRET`. |

## Failure modes worth knowing

**Stale `.next`.** A killed build leaves `.next/lock` behind and the next build
can wedge on it. `rm -rf apps/web/.next` before rebuilding. Note this also wipes
`.next/standalone`, so step 3 must be redone every time.

**Killing the server.** Next renames its process, so `pkill -f "server.js"`
does **not** match it. Kill by port:

```bash
kill $(lsof -t -nP -iTCP:3100 -sTCP:LISTEN)
```

**Wrapper summaries lie.** A run that aborts in global setup exits 1 having
collected zero tests, which some tool summaries render as `PASS (0) FAIL (0)` —
indistinguishable from a clean skip. Read Playwright's own last line
(`11 passed (15.1s)`) and the exit code, not a wrapper's tally.

**Fresh worktree.** `next build` fails with
`Symlink [project]/node_modules is invalid, it points out of the filesystem root`
if the worktree's root `node_modules` is a symlink to the main checkout. Replace
it with a real directory (`cp -Rc` clones it near-instantly on APFS, or run
`npm ci`).

**A run leaves data behind** in whichever DB it targeted — `TAG`-prefixed users,
orgs and competitions. Expected; use a disposable database.

## CI

`.github/workflows/e2e.yml` starts its own server against its own Postgres
service, with no Redis and job-wide env, then runs `npm run test:e2e` — so the
removal of the `webServer` block changes nothing there (`reuseExistingServer`
meant it never fired in CI), and the preflight passes against it.

One difference remains: CI still starts the server with `npm run start`
(`next start`), which is the mismatch described in step 4. It survives because
`next start` does serve `.next/static` (the chunks it can't find are only a
problem in the *standalone* tree), so the preflight's asset probe passes — but
CI is not exercising the server production runs. Left alone here deliberately:
this workflow is manual-only (Actions → E2E → Run workflow) and is not to be
enabled or edited as part of this change.
