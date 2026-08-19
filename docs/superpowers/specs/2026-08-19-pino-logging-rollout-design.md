# Pino logging rollout — apps/web (phase 1: server-side)

Status: approved, phase 1 in progress
Owner: ashokhein

## Scope

Extend structured (pino) logging across `apps/web` server-side code —
route handlers and usecases. Excludes: `packages/engine/src/core/`
(pure, stays logging-free by design), `packages/engine/src/scheduling/`
(already fully covered, no gap), `scripts/**` (eslint-exempt hand-run
tools, out of scope), and client components (`"use client"` — separate
future sub-project, not this phase).

## Current state (as of 2026-08-19)

- Shared logger: `apps/web/src/server/logger.ts:16` — `pino({ name:
  "web.scheduling", level: process.env.LOG_LEVEL ?? "info" })`. Used
  by 14 of 86 `server/usecases/*.ts` files and 1 of 274 `route.ts`
  files.
- 14 usecases + 4 routes use raw `console.*` instead.
- 59 usecases + 269 routes have no logging at all.
- `packages/engine/src/scheduling/logger.ts:18` is a separate,
  already-complete pino instance (`build.ts`, `placement-client.ts`).
  No work needed there.
- Request id: `apps/web/src/server/api-v1/http.ts:123` generates
  `randomUUID()` per `/api/v1` request and places it in the JSON
  **body** (`requestId` field), not a header. The non-versioned
  wrapper `apps/web/src/lib/http.ts` has no request id at all.
- `apps/web/eslint.config.mjs` has no `no-console` rule (unlike
  `packages/engine/eslint.config.mjs:93`, which enforces it for the
  engine package).

## Design

### 1. Request context carrier

New `apps/web/src/server/request-context.ts`:

```ts
const storage = new AsyncLocalStorage<{ requestId: string; orgId?: string; userId?: string }>();
export const requestContext = storage;
```

Both route wrappers run the handler inside `requestContext.run({...}, handler)`:

- `v1()` / `v1Inner()` in `apps/web/src/server/api-v1/http.ts` — reuse
  its existing `randomUUID()` call as the context's `requestId`
  instead of generating a second one.
- The non-versioned wrapper in `apps/web/src/lib/http.ts` — add the
  same `randomUUID()` call (it has none today), and run inside the
  same context store.

`orgId`/`userId` are set once each wrapper resolves session/org
(both already do this before invoking the handler).

### 2. Zero-touch call sites via pino `mixin`

`apps/web/src/server/logger.ts` adds a `mixin` function instead of
introducing a `child()`/`reqLog()` API:

```ts
export const log = pino(
  {
    name: "web",
    level: process.env.LOG_LEVEL ?? "info",
    mixin: () => requestContext.getStore() ?? {},
  },
  pino.destination({ sync: false }),
);
```

Every `log.info({...}, "msg")` call — existing or new — automatically
picks up `requestId`/`orgId`/`userId` when set, without changing the
call-site API. This also drops the misleading `"web.scheduling"` name
now that the logger is repo-wide, not scheduling-specific.

### 3. Non-blocking writes

`pino.destination({ sync: false })` makes writes explicitly
non-blocking (sonic-boom, no worker thread), removing the TTY/pipe
ambiguity of plain `pino()` writing straight to `process.stdout`. This
does not use `transport:`, preserving the existing constraint that
Next's standalone tracing can't follow `transport`'s dynamic
`require()`.

### 4. Rollout waves

- **Wave a** (this implementation): logger `mixin` + non-blocking
  destination, request-context module, wrapper wiring in both
  `api-v1/http.ts` and `lib/http.ts`. Ships alone first — proves ALS +
  mixin behave correctly under real request handling before any
  call-site migration rides on top of it.
- **Wave b** (follow-up): migrate the 18 existing `console.*` sites
  (14 usecases + 4 routes) to `log.{level}({...}, "event")`. No new
  call sites, validates the pattern.
- **Wave c** (follow-up, batched): backfill the remaining 59 usecases
  + 269 routes, one directory-sized batch per PR.
- **Lint**: hold `no-console: error` for `apps/web` until wave b lands
  clean, then enable it so no new `console.*` regresses mid-rollout.

## Testing

- Wave a: unit test that `requestContext.run()` correctly scopes a
  value per async call (no cross-request leakage under concurrent
  requests — the standard AsyncLocalStorage footgun to guard against).
  Integration test: hit a `/api/v1` route and a non-v1 route, assert
  log output (capture via a test destination) contains `requestId`
  matching the response body's `requestId` for v1, and a generated one
  for non-v1.
- Wave b/c: no new tests required beyond existing coverage — these are
  call-site migrations, not behavior changes.

## Out of scope (explicit)

- Client-side (`"use client"`) logging convention — separate sub-project.
- `packages/engine/src/core/` — stays logging-free, pure functions only.
- `scripts/**` — eslint-exempt, hand-run, not request-serving.
- A checked-in logging convention doc (`docs/logging.md` or similar) —
  worth doing, deferred to after wave c so the doc reflects the
  settled pattern rather than the in-flight one.
